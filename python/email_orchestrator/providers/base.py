"""Base MCP adapter: the orchestrator acting as an MCP *client* to one provider server.

Analogy: each adapter is a telephone line to one mail provider's switchboard.
It dials (connect), asks what extensions exist (list_tools), then places calls
(call_tool). If the line goes dead mid-call, it redials once and repeats the
question — the caller never notices.

Python-specific design note
---------------------------
The MCP Python SDK opens a connection as nested ``async with`` blocks
(transport → ClientSession). anyio requires such a block to be entered and
exited by the *same* task. So each connection lives inside a dedicated
background "runner" task that opens the blocks, hands the live session back,
then parks on a stop event. Tearing down = set the event, and the runner exits
its own blocks cleanly.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any, AsyncIterator, Awaitable, Callable, TypeVar

import anyio
from mcp import ClientSession, StdioServerParameters
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client
from mcp.types import Implementation

from ..core.normalizer import RawEmailData, date_ms, iso_now, normalize_email, normalize_emails
from ..core.types import EmailAccount, McpConnectionConfig
from ..utils.errors import ProviderAuthError, ProviderConnectionError, get_error_message
from ..utils.logger import logger

T = TypeVar("T")

CLIENT_INFO = Implementation(name="email-orchestrator", version="1.0.0")

# Tool names various community MCP servers use for each operation; tried in order.
DEFAULT_TOOL_CANDIDATES: dict[str, list[str]] = {
    "listEmails": [
        "list_emails", "list_messages", "get_messages", "list_mail", "fetch_emails",
        "get_recent_emails", "list_recent_emails", "get_unread_emails", "listEmails", "get_emails",
    ],
    "searchEmails": ["search_emails", "search_messages", "search_mail", "query_emails", "searchEmails", "search"],
    "getEmail": ["get_email", "read_email", "get_message", "read_message", "fetch_email", "get_mail", "getEmail"],
    "createDraft": [
        "create_draft", "draft_email", "save_draft", "compose_draft", "createDraft", "draft", "compose_email",
    ],
}

_AUTH_RE = re.compile(r"unauthor|forbidden|401|403|invalid[_ ]?token|\bauth", re.I)
_DROP_RE = re.compile(
    r"unexpected close|connection closed|closed unexpectedly|not connected|transport (is )?closed|"
    r"econnreset|epipe|broken pipe|socket hang up|write after end|terminated|premature close|stream closed",
    re.I,
)


def _leaf(error: BaseException) -> BaseException:
    """anyio task groups wrap failures in ExceptionGroups; dig out the real cause."""
    while isinstance(error, BaseExceptionGroup) and error.exceptions:
        error = error.exceptions[0]
    return error


def is_connection_drop(error: BaseException) -> bool:
    error = _leaf(error)
    if isinstance(error, (anyio.ClosedResourceError, anyio.BrokenResourceError, anyio.EndOfStream,
                          BrokenPipeError, ConnectionResetError)):
        return True
    return bool(_DROP_RE.search(str(error)))


class BaseMcpAdapter:
    CONNECT_RETRIES = 3
    RECONNECT_COOLDOWN_S = 60.0
    CONNECT_TIMEOUT_S = 60.0
    CALL_TIMEOUT_S = 120.0

    def __init__(self, account: EmailAccount) -> None:
        if account.connection is None:
            raise ProviderConnectionError(
                account.provider, f'Account "{account.id}" has no MCP connection configured', {"accountId": account.id}
            )
        self.account_id = account.id
        self.provider = account.provider
        self.email = account.email
        self.display_name = account.display_name
        self.connection: McpConnectionConfig = account.connection
        self.log = logger.child(f"adapter:{account.id}")

        self.discovered_tools: list[str] = []
        self._session: ClientSession | None = None
        self._connected = False
        self._last_synced_at: str | None = None

        self._connect_task: asyncio.Task[None] | None = None
        self._generation = 0
        self._last_connect_error: tuple[float, str] | None = None
        self._runner: asyncio.Task[None] | None = None
        self._stop: asyncio.Event | None = None

    # ------------------------------------------------------------ hooks for subclasses

    def preferred_tool_names(self) -> dict[str, list[str]]:
        return {}

    def build_list_args(self, options: dict[str, Any]) -> dict[str, Any]:
        n = options.get("maxResults") or 25
        args: dict[str, Any] = {"maxResults": n, "max_results": n, "folder": options.get("folder") or "INBOX"}
        if options.get("unreadOnly"):
            args["unreadOnly"] = True
            args["query"] = "is:unread"
        return args

    def build_search_args(self, query: str, options: dict[str, Any]) -> dict[str, Any]:
        n = options.get("maxResults") or 25
        return {"query": query, "q": query, "maxResults": n, "max_results": n}

    def build_get_args(self, email_id: str) -> dict[str, Any]:
        return {"id": email_id, "messageId": email_id, "message_id": email_id, "uid": email_id}

    def build_draft_args(self, draft: dict[str, Any]) -> dict[str, Any]:
        return {
            "to": ", ".join(draft.get("to") or []),
            "cc": ", ".join(draft["cc"]) if draft.get("cc") else None,
            "bcc": ", ".join(draft["bcc"]) if draft.get("bcc") else None,
            "subject": draft.get("subject"),
            "body": draft.get("body"),
            "inReplyTo": draft.get("inReplyTo"),
            "threadId": draft.get("threadId"),
        }

    def extract_email_list(self, parsed: Any) -> list[RawEmailData]:
        return coerce_email_array(parsed)

    def extract_email(self, parsed: Any) -> RawEmailData | None:
        arr = coerce_email_array(parsed)
        return arr[0] if arr else None

    async def after_connect(self) -> None:
        """Runs after every successful (re)connect. IMAP re-provisions its account here."""

    def on_connection_lost(self) -> None:
        """Runs whenever the connection is known to be gone. Reset per-connection state here."""

    # ------------------------------------------------------------ connection lifecycle

    def is_connected(self) -> bool:
        return self._connected and self._session is not None

    async def connect(self) -> None:
        await self.ensure_connected()

    async def ensure_connected(self) -> None:
        if self.is_connected():
            return
        if self._connect_task is not None:  # someone is already dialing — share that attempt
            await asyncio.shield(self._connect_task)
            return
        err = self._last_connect_error
        if err and time.monotonic() - err[0] < self.RECONNECT_COOLDOWN_S:
            raise ProviderConnectionError(
                self.provider, f"Not reconnecting yet (cooling down after: {err[1]})", {"accountId": self.account_id}
            )

        async def attempt() -> None:
            try:
                await self._establish_with_retry()
                await self.after_connect()
                self._last_connect_error = None
            except Exception as e:
                self._last_connect_error = (time.monotonic(), get_error_message(e))
                raise
            finally:
                self._connect_task = None

        self._connect_task = asyncio.ensure_future(attempt())
        await asyncio.shield(self._connect_task)

    async def disconnect(self) -> None:
        await self._teardown()
        self._last_connect_error = None
        self.on_connection_lost()

    async def _establish_with_retry(self) -> None:
        last: BaseException | None = None
        for attempt in range(1, self.CONNECT_RETRIES + 1):
            try:
                await self._establish()
                if attempt > 1:
                    self.log.info(f"Reconnected to {self.provider} MCP server on attempt {attempt}")
                return
            except Exception as e:
                last = _leaf(e)
                await self._teardown()
                message = get_error_message(last)
                if _AUTH_RE.search(message):
                    raise ProviderAuthError(self.provider, f"Authentication failed: {message}") from last
                if "timed out" in message.lower():
                    raise ProviderConnectionError(self.provider, f"Connect {message}", {"accountId": self.account_id}) from last
                if attempt < self.CONNECT_RETRIES:
                    await asyncio.sleep(attempt * 0.5)  # linear backoff: 0.5s, 1s
        raise ProviderConnectionError(
            self.provider,
            f"Failed to connect after {self.CONNECT_RETRIES} attempts: {get_error_message(last)}",
            {"accountId": self.account_id},
        )

    async def _establish(self) -> None:
        self._generation += 1
        generation = self._generation
        loop = asyncio.get_running_loop()
        ready: asyncio.Future[tuple[ClientSession, list[str]]] = loop.create_future()
        stop = asyncio.Event()
        self._stop = stop
        self._runner = asyncio.create_task(self._run_connection(generation, ready, stop))
        session, tools = await ready
        self.discovered_tools = tools
        self._session = session
        self._connected = True
        self.log.info(
            f"Connected to {self.provider} MCP server",
            {"toolCount": len(tools), "transport": self.connection.transport},
        )

    async def _run_connection(self, generation: int, ready: asyncio.Future, stop: asyncio.Event) -> None:
        timeout_ms = int(self.CONNECT_TIMEOUT_S * 1000)
        try:
            async with self.open_transport() as (read, write):
                async with ClientSession(
                    read, write, client_info=CLIENT_INFO, read_timeout_seconds=timedelta(seconds=self.CALL_TIMEOUT_S)
                ) as session:
                    try:
                        await asyncio.wait_for(session.initialize(), self.CONNECT_TIMEOUT_S)
                    except asyncio.TimeoutError:
                        raise TimeoutError(f"{self.provider} connect timed out after {timeout_ms}ms") from None
                    try:
                        listed = await asyncio.wait_for(session.list_tools(), self.CONNECT_TIMEOUT_S)
                    except asyncio.TimeoutError:
                        raise TimeoutError(f"{self.provider} listTools timed out after {timeout_ms}ms") from None
                    ready.set_result((session, [t.name for t in listed.tools]))
                    await stop.wait()
        except BaseException as e:  # noqa: BLE001 — must also see CancelledError to release waiters
            if not ready.done():
                ready.set_exception(_leaf(e) if isinstance(_leaf(e), Exception) else ProviderConnectionError(self.provider, "connect cancelled"))
            elif not stop.is_set():
                self._on_drop(generation, e)
            if isinstance(e, asyncio.CancelledError):
                raise
        else:
            if not stop.is_set():
                self._on_drop(generation, None)

    def _on_drop(self, generation: int, reason: BaseException | None) -> None:
        if generation != self._generation:
            return  # superseded by a newer connection
        if self._connected:
            self.log.warn(
                f"{self.provider} MCP connection dropped; will reconnect on next use",
                {"reason": get_error_message(_leaf(reason)) if reason else None},
            )
        self._connected = False
        self._session = None
        self.on_connection_lost()

    async def _teardown(self) -> None:
        self._generation += 1  # invalidate the old runner's drop handler before detaching
        self._session = None
        self._connected = False
        runner, stop = self._runner, self._stop
        self._runner = self._stop = None
        if stop is not None:
            stop.set()
        if runner is not None and not runner.done():
            try:
                await asyncio.wait_for(asyncio.shield(runner), 5)
            except asyncio.TimeoutError:
                runner.cancel()
            except BaseException as e:  # noqa: BLE001 — closing a dead transport can raise; ignore
                self.log.debug("Error while closing MCP client", {"error": get_error_message(_leaf(e))})

    async def _with_connection(self, fn: Callable[[], Awaitable[T]]) -> T:
        """Run ``fn``; if the line went dead mid-call, redial once and retry."""
        await self.ensure_connected()
        try:
            return await fn()
        except Exception as e:
            if not is_connection_drop(e):
                raise
            self.log.warn(
                f"{self.provider} call hit a dropped connection; reconnecting and retrying once",
                {"error": get_error_message(_leaf(e))},
            )
            await self._teardown()
            self.on_connection_lost()
            self._last_connect_error = None
            await self.ensure_connected()
            return await fn()

    # ------------------------------------------------------------ transports

    @asynccontextmanager
    async def open_transport(self) -> AsyncIterator[tuple[Any, Any]]:
        """Yield ``(read_stream, write_stream)`` for this account's transport. Tests override this."""
        c = self.connection
        if c.transport == "stdio":
            if not c.command:
                raise ProviderConnectionError(self.provider, "stdio transport requires a command")
            params = StdioServerParameters(command=c.command, args=list(c.args), env={**os.environ, **(c.env or {})})
            async with stdio_client(params) as (read, write):
                yield read, write
        elif c.transport == "sse":
            if not c.url:
                raise ProviderConnectionError(self.provider, "sse transport requires a url")
            async with sse_client(c.url, headers=c.headers) as (read, write):
                yield read, write
        elif c.transport == "http":
            if not c.url:
                raise ProviderConnectionError(self.provider, "http transport requires a url")
            async with streamablehttp_client(c.url, headers=c.headers) as (read, write, _get_session_id):
                yield read, write
        else:
            raise ProviderConnectionError(self.provider, f"Unknown transport: {c.transport}")

    # ------------------------------------------------------------ operations

    async def list_emails(self, options: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        options = options or {}
        parsed = await self.call_operation("listEmails", self.build_list_args(options))
        emails = normalize_emails(self.extract_email_list(parsed), self.provider, self.account_id, self.email)
        self._last_synced_at = iso_now()
        return apply_client_side_filters(emails, options)

    async def search_emails(self, query: str, options: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        options = options or {}
        parsed = await self.call_operation("searchEmails", self.build_search_args(query, options))
        emails = normalize_emails(self.extract_email_list(parsed), self.provider, self.account_id, self.email)
        self._last_synced_at = iso_now()
        return apply_client_side_filters(emails, options)

    async def get_email(self, email_id: str) -> dict[str, Any] | None:
        parsed = await self.call_operation("getEmail", self.build_get_args(email_id))
        raw = self.extract_email(parsed)
        if not raw:
            return None
        try:
            return normalize_email(raw, self.provider, self.account_id, self.email)
        except Exception:
            return None

    async def create_draft(self, draft: dict[str, Any]) -> dict[str, str]:
        parsed = await self.call_operation("createDraft", self.build_draft_args(draft))
        draft_id = extract_draft_id(parsed) or f"draft-{int(time.time() * 1000)}"
        self.log.info("Draft created", {"draftId": draft_id})
        return {"draftId": draft_id, "accountId": self.account_id, "provider": self.provider}

    def get_status(self) -> dict[str, Any]:
        status: dict[str, Any] = {
            "accountId": self.account_id,
            "accountEmail": self.email,
            "provider": self.provider,
            "totalEmails": 0,
            "unreadCount": 0,
            "isConnected": self._connected,
        }
        if self._last_synced_at:
            status["lastSyncedAt"] = self._last_synced_at
        return status

    # ------------------------------------------------------------ tool plumbing

    def resolve_tool_name(self, operation: str) -> str:
        """Map an abstract operation to a concrete downstream tool name (5-step fallback)."""
        override = (self.connection.tool_map or {}).get(operation)
        if override and override in self.discovered_tools:
            return override
        preferred = self.preferred_tool_names().get(operation, [])
        for name in preferred:
            if name in self.discovered_tools:
                return name
        for name in DEFAULT_TOOL_CANDIDATES[operation]:
            if name in self.discovered_tools:
                return name
        fragments = [re.sub(r"[_-]", "", n).lower() for n in [*preferred, *DEFAULT_TOOL_CANDIDATES[operation]]]
        for discovered in self.discovered_tools:
            flat = re.sub(r"[_-]", "", discovered).lower()
            if any(f in flat or flat in f for f in fragments):
                return discovered
        raise ProviderConnectionError(
            self.provider,
            f'No downstream tool found for operation "{operation}". '
            f"Discovered tools: [{', '.join(self.discovered_tools)}]. "
            "Set a toolMap override in this account's connection config.",
            {"operation": operation, "discoveredTools": self.discovered_tools},
        )

    async def call_operation(self, operation: str, args: dict[str, Any]) -> Any:
        clean = drop_none(args)

        async def run() -> Any:
            tool_name = self.resolve_tool_name(operation)
            self.log.debug("Calling downstream tool", {"operation": operation, "toolName": tool_name})
            return await self._invoke(tool_name, clean)

        return await self._with_connection(run)

    async def call_tool_raw(self, name: str, args: dict[str, Any]) -> Any:
        clean = drop_none(args)
        return await self._with_connection(lambda: self._invoke(name, clean))

    async def _invoke(self, name: str, args: dict[str, Any]) -> Any:
        session = self._session
        if session is None:
            raise ProviderConnectionError(self.provider, "Not connected")
        result = await session.call_tool(name, args)
        if result.isError:
            raise ProviderConnectionError(
                self.provider, f'Downstream tool "{name}" failed: {extract_text(result)}', {"toolName": name}
            )
        return parse_tool_result(result)


class GenericAdapter(BaseMcpAdapter):
    """Any MCP mail server not covered by a dedicated adapter."""


# ---------------------------------------------------------------- pure helpers (unit-tested)


def drop_none(obj: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in obj.items() if v is not None}


def _get(obj: Any, key: str) -> Any:
    return obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)


def extract_text(result: Any) -> str:
    content = _get(result, "content")
    if not isinstance(content, list):
        return ""
    return "\n".join(
        _get(b, "text") for b in content if _get(b, "type") == "text" and isinstance(_get(b, "text"), str)
    )


def _try_json(text: str) -> Any:
    try:
        return json.loads(text.strip())
    except ValueError:
        return _MISSING


_MISSING = object()


def parse_tool_result(result: Any) -> Any:
    """Turn an MCP CallToolResult into Python data: structured → JSON text → embedded JSON → raw text."""
    structured = _get(result, "structuredContent")
    if structured is not None:
        return structured
    text = extract_text(result)
    if not text:
        return None
    direct = _try_json(text)
    if direct is not _MISSING:
        return direct
    # Salvage a JSON array/object embedded in human-readable text.
    starts = [i for i in (text.find("["), text.find("{")) if i != -1]
    if starts:
        start = min(starts)
        close = "]" if text[start] == "[" else "}"
        end = text.rfind(close)
        if end > start:
            embedded = _try_json(text[start : end + 1])
            if embedded is not _MISSING:
                return embedded
    return text


def coerce_email_array(parsed: Any) -> list[RawEmailData]:
    if parsed is None:
        return []
    if isinstance(parsed, list):
        return [x for x in parsed if isinstance(x, dict)]
    if isinstance(parsed, dict):
        for key in ("emails", "messages", "items", "data", "results", "value"):
            inner = parsed.get(key)
            if isinstance(inner, list):
                return [x for x in inner if isinstance(x, dict)]
        if any(k in parsed for k in ("id", "messageId", "uid", "subject")):
            return [parsed]
    return []


def extract_draft_id(parsed: Any) -> str | None:
    if isinstance(parsed, str):
        m = re.search(r"([A-Za-z0-9_-]{6,})", parsed)
        return m.group(1) if m else None
    if isinstance(parsed, dict):
        for key in ("draftId", "id", "messageId", "draft_id"):
            v = parsed.get(key)
            if isinstance(v, str) and v:
                return v
        nested = parsed.get("draft")
        if isinstance(nested, dict) and isinstance(nested.get("id"), str):
            return nested["id"]
    return None


def apply_client_side_filters(emails: list[dict[str, Any]], options: dict[str, Any]) -> list[dict[str, Any]]:
    """Enforce the query options ourselves, since not every server honours them."""
    out = emails
    if options.get("unreadOnly"):
        out = [e for e in out if not e["isRead"]]
    if options.get("since"):
        cutoff = date_ms(options["since"])
        if cutoff is not None:
            out = [e for e in out if (date_ms(e["date"]) is None or date_ms(e["date"]) >= cutoff)]
    max_results = options.get("maxResults")
    if max_results and len(out) > max_results:
        out = out[:max_results]
    return out

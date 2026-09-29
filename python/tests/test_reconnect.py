"""Regression tests for self-healing reconnection (port of tests/providers/reconnect.test.ts).

These reproduce two production failures:
  - Yahoo "Unexpected close": the IMAP child's connection drops mid-request and the
    adapter must reconnect AND re-provision its account into the fresh child.
  - A provider staying "connected" forever after its child died, so every later call
    threw instead of transparently reconnecting.

No real child process is needed: ``open_transport`` is overridden to wire the adapter to
an in-memory MCP server, and a drop is simulated by closing the server's outgoing stream
mid-call (exactly what a crashed child looks like from the client's side).
"""

from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from typing import Any, Callable

import anyio
import pytest
import mcp.types as types
from mcp.server.lowlevel import Server
from mcp.shared.memory import create_client_server_memory_streams

from email_orchestrator.core.types import EmailAccount, McpConnectionConfig
from email_orchestrator.providers.base import BaseMcpAdapter
from email_orchestrator.providers.gmail import GmailAdapter, raise_if_error_text
from email_orchestrator.providers.imap import ImapAdapter
from email_orchestrator.utils.errors import ProviderAuthError, ProviderConnectionError

ToolHandler = Callable[[dict[str, Any]], str]


@asynccontextmanager
async def serve_tools(tools_factory: Callable[[Callable[[], None]], dict[str, ToolHandler]]):
    """Yield client streams wired to a fresh in-memory MCP server.

    ``tools_factory(drop)`` builds the tool table; a handler calls ``drop()`` to kill the
    connection mid-request.
    """
    async with create_client_server_memory_streams() as (client_streams, server_streams):
        server_read, server_write = server_streams

        def drop() -> None:
            server_write.close()  # client sees EndOfStream -> pending request fails "Connection closed"

        tools = tools_factory(drop)
        server = Server("fake-provider")

        @server.list_tools()
        async def _list() -> list[types.Tool]:
            return [types.Tool(name=n, description=n, inputSchema={"type": "object"}) for n in tools]

        @server.call_tool(validate_input=False)
        async def _call(name: str, arguments: dict[str, Any]) -> list[types.TextContent]:
            handler = tools.get(name)
            return [types.TextContent(type="text", text=handler(arguments or {}) if handler else "[]")]

        async def run_server() -> None:
            try:
                await server.run(server_read, server_write, server.create_initialization_options())
            except Exception:
                pass  # a deliberately dropped connection makes the server's run loop fail; that's the point

        async with anyio.create_task_group() as tg:
            tg.start_soon(run_server)
            try:
                yield client_streams
            finally:
                tg.cancel_scope.cancel()


def account(**over: Any) -> EmailAccount:
    base = dict(id="test-primary", provider="gmail", email="me@example.com", display_name="Test",
                connection=McpConnectionConfig(transport="stdio", command="node"))
    return EmailAccount(**{**base, **over})


# ---------------------------------------------------------------- generic adapter

class ReconnectingAdapter(BaseMcpAdapter):
    def __init__(self, acct: EmailAccount) -> None:
        super().__init__(acct)
        self.connect_count = 0
        self.call_count = 0
        self.drop_on_call_no: int | None = None

    def preferred_tool_names(self) -> dict[str, list[str]]:
        return {"listEmails": ["list_emails"]}

    @asynccontextmanager
    async def open_transport(self):
        self.connect_count += 1

        def tools(drop):
            def list_emails(_args):
                self.call_count += 1
                if self.drop_on_call_no is not None and self.call_count == self.drop_on_call_no:
                    self.drop_on_call_no = None
                    drop()  # simulate the child dying mid-request
                return json.dumps([{"id": "1", "subject": "ok"}])
            return {"list_emails": list_emails}

        async with serve_tools(tools) as streams:
            yield streams


async def test_connects_lists_and_reports_connected():
    adapter = ReconnectingAdapter(account())
    await adapter.connect()
    assert adapter.is_connected()
    assert len(await adapter.list_emails()) == 1
    assert adapter.connect_count == 1
    await adapter.disconnect()


async def test_reconnects_and_retries_after_a_mid_call_drop():
    adapter = ReconnectingAdapter(account())
    await adapter.connect()
    adapter.drop_on_call_no = 1  # the next list_emails call kills the connection
    emails = await adapter.list_emails()  # must transparently recover
    assert len(emails) == 1
    assert adapter.connect_count == 2  # reconnected exactly once
    assert adapter.is_connected()
    await adapter.disconnect()


async def test_stays_healthy_after_recovery():
    adapter = ReconnectingAdapter(account())
    await adapter.connect()
    adapter.drop_on_call_no = 1
    await adapter.list_emails()  # drop + auto-reconnect
    assert adapter.is_connected()
    assert len(await adapter.list_emails()) == 1
    assert adapter.connect_count == 2
    await adapter.disconnect()


# ---------------------------------------------------------------- IMAP re-provisioning

def imap_account() -> EmailAccount:
    return account(
        id="yahoo-primary", provider="yahoo", email="me@yahoo.com",
        connection=McpConnectionConfig(transport="stdio", command="node", env={
            "IMAP_HOST": "imap.mail.yahoo.com", "IMAP_PORT": "993", "IMAP_USER": "me@yahoo.com",
            "IMAP_PASSWORD": "test-app-password", "IMAP_TLS": "true",
        }),
    )


class ImapTestAdapter(ImapAdapter):
    def __init__(self, acct: EmailAccount) -> None:
        super().__init__(acct)
        self.add_count = 0
        self.connect_count = 0
        self.drop_next_latest = False

    @asynccontextmanager
    async def open_transport(self):
        self.connect_count += 1
        # Each new child starts with an EMPTY account store — the crux of the Yahoo bug.
        accounts: set[str] = set()

        def tools(drop):
            def add(args):
                accounts.add(str(args.get("name", "")))
                self.add_count += 1
                return json.dumps({"ok": True})

            def latest(_args):
                if self.drop_next_latest:
                    self.drop_next_latest = False
                    drop()
                    return "[]"
                return json.dumps({"messages": [{"uid": 5, "subject": "hi", "from": "a@b.com", "flags": []}]})

            return {
                "imap_list_accounts": lambda _a: json.dumps({"accounts": [{"name": n} for n in accounts]}),
                "imap_add_account": add,
                "imap_get_latest_emails": latest,
            }

        async with serve_tools(tools) as streams:
            yield streams


async def test_imap_reprovisions_account_on_fresh_child_after_drop():
    adapter = ImapTestAdapter(imap_account())
    await adapter.connect()
    assert adapter.add_count == 1  # provisioned once on first connect
    assert len(await adapter.list_emails()) == 1

    adapter.drop_next_latest = True  # next read kills the child mid-request
    assert len(await adapter.list_emails()) == 1  # read still succeeds
    assert adapter.connect_count == 2  # reconnected to a fresh child
    assert adapter.add_count == 2  # AND re-provisioned the account into it
    await adapter.disconnect()


# ---------------------------------------------------------------- Gmail unread count

class GmailTestAdapter(GmailAdapter):
    @asynccontextmanager
    async def open_transport(self):
        text = ("ID: 1\nSubject: Hello\nFrom: a@b.com\nDate: 2026-08-10\n\n"
                "ID: 2\nSubject: World\nFrom: c@d.com\nDate: 2026-08-10")
        async with serve_tools(lambda _drop: {"search_emails": lambda _a: text}) as streams:
            yield streams


async def test_gmail_keeps_unread_rows():
    """gongrzhe's plain text carries no read flag; unread queries must not drop every row."""
    adapter = GmailTestAdapter(account(provider="gmail"))
    await adapter.connect()
    unread = await adapter.list_emails({"unreadOnly": True, "maxResults": 100})
    assert len(unread) == 2  # was 0 before the fix
    assert all(not e["isRead"] for e in unread)
    await adapter.disconnect()


# ---------------------------------------------------------------- Gmail errors disguised as text

class GmailErrorAdapter(GmailAdapter):
    """gongrzhe returns failures as plain text ("Error: ...") with isError unset."""

    def __init__(self, acct: EmailAccount, reply: str) -> None:
        super().__init__(acct)
        self.reply = reply
        self.connect_count = 0

    @asynccontextmanager
    async def open_transport(self):
        self.connect_count += 1
        async with serve_tools(lambda _drop: {"search_emails": lambda _a: self.reply}) as streams:
            yield streams


async def test_gmail_expired_login_raises_instead_of_listing_zero():
    adapter = GmailErrorAdapter(account(provider="gmail"), "Error: invalid_grant")
    await adapter.connect()
    with pytest.raises(ProviderAuthError) as exc:
        await adapter.list_emails()  # was: [] (an expired login looked like an empty inbox)
    assert "invalid_grant" in str(exc.value) and "reauth-gmail" in str(exc.value)
    assert adapter.connect_count == 1  # an auth failure is not a dropped line: no reconnect loop
    await adapter.disconnect()


async def test_gmail_other_error_text_raises_connection_error():
    adapter = GmailErrorAdapter(account(provider="gmail"), "Error: Quota exceeded for quota metric")
    await adapter.connect()
    with pytest.raises(ProviderConnectionError, match="Quota exceeded"):
        await adapter.search_emails("from:someone")
    await adapter.disconnect()


def test_raise_if_error_text_passes_real_results_through():
    text = "ID: 1\nSubject: Error: build failed\nFrom: ci@x.com"  # "Error:" mid-text is just a subject
    assert raise_if_error_text(text) is text
    assert raise_if_error_text({"messages": []}) == {"messages": []}


class GmailReauthAdapter(GmailAdapter):
    """First child has a dead token; any child started after re-auth answers normally."""

    def __init__(self, acct: EmailAccount) -> None:
        super().__init__(acct)
        self.connect_count = 0

    @asynccontextmanager
    async def open_transport(self):
        self.connect_count += 1
        reply = "Error: invalid_grant" if self.connect_count == 1 else "ID: 1\nSubject: Hello\nFrom: a@b.com"
        async with serve_tools(lambda _drop: {"search_emails": lambda _a: reply}) as streams:
            yield streams


async def test_gmail_picks_up_a_new_sign_in_without_a_restart(tmp_path):
    creds = tmp_path / "credentials.json"
    creds.write_text("{}")
    conn = McpConnectionConfig(transport="stdio", command="node", env={"GMAIL_CREDENTIALS_PATH": str(creds)})
    adapter = GmailReauthAdapter(account(provider="gmail", connection=conn))
    await adapter.connect()
    with pytest.raises(ProviderAuthError):
        await adapter.list_emails()  # token file unchanged -> no pointless restart
    assert adapter.connect_count == 1

    stat = creds.stat()
    os.utime(creds, (stat.st_atime, stat.st_mtime + 60))  # the user re-authorized
    assert len(await adapter.list_emails()) == 1  # restarted the child and read the new token
    assert adapter.connect_count == 2
    await adapter.disconnect()

"""Yahoo / Outlook(app-password) / generic IMAP via ``imap-mcp-server``.

That server keeps an in-memory list of IMAP accounts. A freshly spawned child
knows none, so after *every* (re)connect we must register ours again with
``imap_add_account`` — forgetting this after a reconnect was the root cause of
the production "Yahoo: Unexpected close" failures.
"""

from __future__ import annotations

from typing import Any

from ..core.normalizer import RawEmailData, parse_date
from ..utils.errors import ProviderConnectionError
from .base import BaseMcpAdapter

DEFAULT_FOLDER = "INBOX"
LIST_BODY_MAX = 4000


class ImapAdapter(BaseMcpAdapter):
    def __init__(self, account) -> None:
        super().__init__(account)
        self._ready = False
        self._folder_by_uid: dict[str, str] = {}
        self._pending_folder = DEFAULT_FOLDER

    def preferred_tool_names(self) -> dict[str, list[str]]:
        return {
            "listEmails": ["imap_get_latest_emails"],
            "searchEmails": ["imap_search_emails"],
            "getEmail": ["imap_get_email"],
        }

    def on_connection_lost(self) -> None:
        self._ready = False
        self._folder_by_uid.clear()

    async def after_connect(self) -> None:
        await self._ensure_account()

    async def list_emails(self, options=None):
        options = options or {}
        await self._ensure_account()
        self._pending_folder = options.get("folder") or DEFAULT_FOLDER
        return await super().list_emails(options)

    async def search_emails(self, query, options=None):
        options = options or {}
        await self._ensure_account()
        self._pending_folder = options.get("folder") or DEFAULT_FOLDER
        return await super().search_emails(query, options)

    async def get_email(self, email_id: str):
        await self._ensure_account()
        return await super().get_email(email_id)

    async def create_draft(self, draft):
        raise ProviderConnectionError(
            self.provider,
            "Saving drafts is not supported for IMAP accounts (read-only tool set). "
            "smart_reply still returns the drafted reply text for you to send manually.",
            {"accountId": self.account_id},
        )

    def build_list_args(self, options: dict[str, Any]) -> dict[str, Any]:
        return {
            "accountName": self.account_id,
            "folder": options.get("folder") or DEFAULT_FOLDER,
            "count": _clamp(options.get("maxResults")),
            "includeBody": True,
            "bodyFormat": "auto",
            "bodyMaxLength": LIST_BODY_MAX,
        }

    def build_search_args(self, query: str, options: dict[str, Any]) -> dict[str, Any]:
        args: dict[str, Any] = {
            "accountName": self.account_id,
            "folder": options.get("folder") or DEFAULT_FOLDER,
            "subject": query,
        }
        if options.get("unreadOnly"):
            args["seen"] = False
        if options.get("since"):
            dt = parse_date(options["since"])
            if dt:
                args["since"] = dt.date().isoformat()
        return args

    def build_get_args(self, email_id: str) -> dict[str, Any]:
        try:
            uid: Any = int(email_id)
        except ValueError:
            uid = email_id
        return {
            "accountName": self.account_id,
            "folder": self._folder_by_uid.get(email_id, DEFAULT_FOLDER),
            "uid": uid,
            "bodyFormat": "auto",  # text/plain if present, else clean Markdown
        }

    def extract_email_list(self, parsed: Any) -> list[RawEmailData]:
        return [self._map_message(m, self._pending_folder) for m in _as_message_array(parsed)]

    def extract_email(self, parsed: Any) -> RawEmailData | None:
        email = parsed["email"] if isinstance(parsed, dict) and "email" in parsed else parsed
        if not isinstance(email, dict):
            return None
        return self._map_message(email, str(email.get("folder") or self._pending_folder))

    async def _ensure_account(self) -> None:
        if self._ready:
            return
        creds = self._read_credentials()
        existing: list[dict[str, Any]] = []
        try:
            listed = await self.call_tool_raw("imap_list_accounts", {})
            accounts = listed.get("accounts") if isinstance(listed, dict) else None
            if isinstance(accounts, list):
                existing = [a for a in accounts if isinstance(a, dict)]
        except Exception as e:
            self.log.warn("IMAP: imap_list_accounts failed; will attempt imap_add_account", {"error": str(e)})

        if not any(str(a.get("name") or "") == self.account_id for a in existing):
            await self.call_tool_raw(
                "imap_add_account",
                {
                    "name": self.account_id,
                    "host": creds["host"],
                    "port": creds["port"],
                    "user": creds["user"],
                    "password": creds["password"],
                    "tls": creds["tls"],
                    "email": self.email or creds["user"],
                },
            )
            self.log.info("IMAP: provisioned account", {"name": self.account_id, "host": creds["host"], "port": creds["port"]})
        self._ready = True

    def _read_credentials(self) -> dict[str, Any]:
        cenv = self.connection.env or {}
        host, user, password = cenv.get("IMAP_HOST", ""), cenv.get("IMAP_USER", ""), cenv.get("IMAP_PASSWORD", "")
        try:
            port = int(cenv.get("IMAP_PORT", "993")) or 993
        except ValueError:
            port = 993
        tls = cenv.get("IMAP_TLS", "true") != "false"
        if not host or not user or not password:
            prefix = {"outlook": "OUTLOOK", "yahoo": "YAHOO"}.get(self.provider, "IMAP")
            raise ProviderConnectionError(
                self.provider,
                f'Missing IMAP credentials for "{self.account_id}". Set {prefix}_EMAIL and '
                f"{prefix}_APP_PASSWORD (and host/port if non-default) in .env.",
                {"accountId": self.account_id},
            )
        return {"host": host, "port": port, "user": user, "password": password, "tls": tls}

    def _map_message(self, m: dict[str, Any], fallback_folder: str) -> RawEmailData:
        uid = m.get("uid")
        uid_str = str(uid) if uid is not None else ""
        flags = [str(f) for f in m.get("flags") or []] if isinstance(m.get("flags"), list) else []
        folder = str(m.get("folder") or fallback_folder)
        if uid_str:
            self._folder_by_uid[uid_str] = folder
        body = _first_string(m.get("textContent"), m.get("markdownContent"), m.get("text"), m.get("body"))
        html = _first_string(m.get("htmlContent"), m.get("html"))
        keywords = [str(k) for k in m.get("customKeywords") or []] if isinstance(m.get("customKeywords"), list) else []
        raw: RawEmailData = {
            "id": uid_str,
            "uid": uid,
            "messageId": str(m["messageId"]) if m.get("messageId") is not None else None,
            "subject": str(m["subject"]) if m.get("subject") is not None else "(No Subject)",
            "from": m.get("from"),  # "Name <email>" string — parse_contact handles it
            "to": m.get("to"),
            "cc": m.get("cc"),
            "date": str(m["date"]) if m.get("date") is not None else None,
            "isRead": "\\Seen" in flags,
            "isStarred": "\\Flagged" in flags,
            "folder": folder,
            "labels": keywords,
        }
        if body:
            raw["text"] = body
            raw["snippet"] = body
        if html:
            raw["htmlContent"] = html
        return raw


def _clamp(n: int | None) -> int:
    return min(max(n or 25, 1), 200)


def _as_message_array(parsed: Any) -> list[dict[str, Any]]:
    if isinstance(parsed, list):
        arr = parsed
    elif isinstance(parsed, dict) and isinstance(parsed.get("messages"), list):
        arr = parsed["messages"]
    elif isinstance(parsed, dict) and isinstance(parsed.get("emails"), list):
        arr = parsed["emails"]
    else:
        arr = []
    return [x for x in arr if isinstance(x, dict)]


def _first_string(*vals: Any) -> str | None:
    for v in vals:
        if isinstance(v, str) and v:
            return v
    return None

"""Gmail via ``@gongrzhe/server-gmail-autoauth-mcp``.

That server answers in *plain text*, not JSON::

    ID: 18c...
    Subject: Hello
    From: a@b.com
    Date: Mon, 10 Aug 2026 09:00:00 +0000

so this adapter parses the text itself. Its search rows carry no read/unread
flag, so when we asked for ``is:unread`` we tag every returned row as unread.
"""

from __future__ import annotations

import math
import re
import time
from typing import Any

from ..core.normalizer import RawEmailData, normalize_email, parse_date
from .base import BaseMcpAdapter


class GmailAdapter(BaseMcpAdapter):
    def __init__(self, account) -> None:
        super().__init__(account)
        self._pending_unread_only = False

    def preferred_tool_names(self) -> dict[str, list[str]]:
        return {
            "listEmails": ["search_emails", "list_messages", "list_emails"],
            "searchEmails": ["search_emails", "search_messages"],
            "getEmail": ["read_email", "get_message", "get_email"],
            "createDraft": ["draft_email", "create_draft"],
        }

    async def list_emails(self, options=None):
        options = options or {}
        self._pending_unread_only = bool(options.get("unreadOnly"))
        try:
            return await super().list_emails(options)
        finally:
            self._pending_unread_only = False

    async def search_emails(self, query, options=None):
        options = options or {}
        self._pending_unread_only = bool(options.get("unreadOnly"))
        try:
            return await super().search_emails(query, options)
        finally:
            self._pending_unread_only = False

    def build_list_args(self, options: dict[str, Any]) -> dict[str, Any]:
        clauses = [f"in:{(options.get('folder') or 'inbox').lower()}"]
        if options.get("unreadOnly"):
            clauses.append("is:unread")
        if options.get("since"):
            days = _days_since(options["since"])
            if days is not None:
                clauses.append(f"newer_than:{days}d")
        return {"query": " ".join(clauses), "maxResults": options.get("maxResults") or 25}

    def build_search_args(self, query: str, options: dict[str, Any]) -> dict[str, Any]:
        q = f"{query} is:unread" if options.get("unreadOnly") and not re.search(r"\bis:unread\b", query) else query
        return {"query": q, "maxResults": options.get("maxResults") or 25}

    def build_draft_args(self, draft: dict[str, Any]) -> dict[str, Any]:
        return {
            "to": draft.get("to"),  # this server wants an array
            "cc": draft.get("cc"),
            "bcc": draft.get("bcc"),
            "subject": draft.get("subject"),
            "body": draft.get("body"),
            "threadId": draft.get("threadId"),
            "inReplyTo": draft.get("inReplyTo"),
        }

    def extract_email_list(self, parsed: Any) -> list[RawEmailData]:
        records = parse_search_list(parsed) if isinstance(parsed, str) else super().extract_email_list(parsed)
        if self._pending_unread_only:
            for r in records:
                r["isRead"] = False
        return records

    async def get_email(self, email_id: str):
        parsed = await self.call_operation("getEmail", self.build_get_args(email_id))
        raw = parse_full_email(parsed) if isinstance(parsed, str) else super().extract_email(parsed)
        if not raw:
            return None
        raw["id"] = email_id  # ensure the id matches what was requested
        try:
            return normalize_email(raw, self.provider, self.account_id, self.email)
        except Exception:
            return None


def _days_since(iso: str) -> int | None:
    dt = parse_date(iso)
    if dt is None:
        return None
    return max(1, math.ceil((time.time() - dt.timestamp()) / 86400))


_LIST_LINE = re.compile(r"^(ID|Subject|From|Date|To|Snippet):\s?(.*)$")
_HEADER_LINE = re.compile(r"^([A-Za-z][A-Za-z ]*?):\s?(.*)$")


def parse_search_list(text: str) -> list[RawEmailData]:
    records: list[RawEmailData] = []
    cur: dict[str, Any] | None = None
    for line in re.split(r"\r?\n", text):
        m = _LIST_LINE.match(line)
        if not m:
            continue
        key, value = m.group(1), m.group(2) or ""
        if key == "ID":
            if cur:
                records.append(cur)
            cur = {"id": value}
        elif cur is not None:
            cur[key.lower()] = value
    if cur:
        records.append(cur)
    return records


def parse_full_email(text: str) -> RawEmailData:
    lines = re.split(r"\r?\n", text)
    record: dict[str, Any] = {}
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.strip() == "":
            i += 1  # blank line separates headers from body
            break
        m = _HEADER_LINE.match(line)
        if not m:
            break
        key, value = m.group(1).strip().lower(), m.group(2) or ""
        if key == "thread id":
            record["threadId"] = value
        elif key in ("message id", "id"):
            record["id"] = value
        else:
            record[key] = value  # subject, from, to, date, cc, ...
        i += 1
    record["body"] = "\n".join(lines[i:]).strip()
    if record["body"]:
        record["snippet"] = record["body"][:200]
    return record

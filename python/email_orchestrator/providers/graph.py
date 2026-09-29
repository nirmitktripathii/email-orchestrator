"""Outlook / Microsoft 365 via a Microsoft Graph MCP server (OAuth route).

Graph MCP servers disagree on tool and argument names, so this adapter sends
the common aliases together (``top``/``count``/``limit``/``maxResults``) and
reads Graph's native message shape (``emailAddress``, ``bodyPreview``, ...).
"""

from __future__ import annotations

import re
from typing import Any

from ..core.normalizer import RawEmailData
from ..utils.errors import ProviderConnectionError
from .base import BaseMcpAdapter, coerce_email_array

_SELECT = (
    "subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,isRead,"
    "hasAttachments,conversationId,parentFolderId"
)


class GraphAdapter(BaseMcpAdapter):
    def preferred_tool_names(self) -> dict[str, list[str]]:
        return {
            "listEmails": [
                "list_messages", "list-messages", "list_mail_messages", "list-mail-messages",
                "get_messages", "list_emails", "list_inbox", "mail_list",
            ],
            "searchEmails": ["search_messages", "search-messages", "search_mail", "search_emails", "query_messages"],
            "getEmail": ["get_message", "get-message", "get_mail_message", "read_message", "get_email", "mail_get"],
        }

    async def create_draft(self, draft):
        raise ProviderConnectionError(
            self.provider,
            "Saving drafts is not supported for the Microsoft Graph adapter (read-only, no-send). "
            "smart_reply still returns the drafted reply text for you to send manually.",
            {"accountId": self.account_id},
        )

    def build_list_args(self, options: dict[str, Any]) -> dict[str, Any]:
        top = _clamp(options.get("maxResults"))
        folder = options.get("folder") or "Inbox"
        args: dict[str, Any] = {
            "top": top, "count": top, "limit": top, "maxResults": top,
            "folder": folder, "mailbox": folder, "folderId": folder,
            "includeBody": True, "select": _SELECT,
        }
        if options.get("unreadOnly"):
            args["filter"] = "isRead eq false"
            args["unreadOnly"] = True
        return args

    def build_search_args(self, query: str, options: dict[str, Any]) -> dict[str, Any]:
        top = _clamp(options.get("maxResults"))
        return {"search": query, "query": query, "q": query, "top": top, "count": top, "limit": top, "maxResults": top}

    def build_get_args(self, email_id: str) -> dict[str, Any]:
        return {"id": email_id, "messageId": email_id, "message_id": email_id, "includeBody": True}

    def extract_email_list(self, parsed: Any) -> list[RawEmailData]:
        if isinstance(parsed, dict) and isinstance(parsed.get("value"), list):
            rows = [x for x in parsed["value"] if isinstance(x, dict)]
        else:
            rows = coerce_email_array(parsed)
        return [map_graph_message(r) for r in rows]

    def extract_email(self, parsed: Any) -> RawEmailData | None:
        obj = _unwrap_single(parsed)
        return map_graph_message(obj) if obj else None


def _clamp(n: int | None) -> int:
    return min(max(n or 25, 1), 200)


def _unwrap_single(parsed: Any) -> dict[str, Any] | None:
    if not isinstance(parsed, dict):
        return None
    if isinstance(parsed.get("value"), list):
        first = parsed["value"][0] if parsed["value"] else None
        return first if isinstance(first, dict) else None
    if isinstance(parsed.get("message"), dict):
        return parsed["message"]
    return parsed


def graph_contact(v: Any) -> dict[str, str]:
    if isinstance(v, dict):
        ea = v.get("emailAddress") or v
        if isinstance(ea, dict):
            return {
                "name": str(ea.get("name") or ea.get("displayName") or ""),
                "email": str(ea.get("address") or ea.get("email") or ""),
            }
    if isinstance(v, str):
        return {"name": v, "email": v}
    return {"name": "", "email": ""}


def map_graph_message(m: dict[str, Any]) -> RawEmailData:
    body_obj = m.get("body") if isinstance(m.get("body"), dict) else {}
    content = body_obj.get("content") if isinstance(body_obj.get("content"), str) else ""
    is_html = str(body_obj.get("contentType") or "").lower() == "html"
    text = _html_to_text(content) if is_html else content
    recips = lambda key: [c for c in (graph_contact(x) for x in m.get(key) or []) if c["email"] or c["name"]] if isinstance(m.get(key), list) else []  # noqa: E731
    raw: RawEmailData = {
        "id": str(m["id"]) if m.get("id") is not None else "",
        "subject": str(m["subject"]) if m.get("subject") is not None else "(No Subject)",
        "from": graph_contact(m.get("from") or m.get("sender")),
        "to": recips("toRecipients"),
        "cc": recips("ccRecipients"),
        "date": str(m["receivedDateTime"]) if m.get("receivedDateTime") is not None else None,
        "snippet": str(m["bodyPreview"]) if m.get("bodyPreview") is not None else "",
        "isRead": bool(m.get("isRead")),
        "hasAttachments": bool(m.get("hasAttachments")),
        "threadId": str(m["conversationId"]) if m.get("conversationId") is not None else None,
        "folder": str(m["parentFolderId"]) if m.get("parentFolderId") is not None else None,
    }
    if text:
        raw["text"] = text
    if is_html and content:
        raw["htmlContent"] = content
    return raw


def _html_to_text(html: str) -> str:
    s = re.sub(r"<style[\s\S]*?</style>", " ", html, flags=re.I)
    s = re.sub(r"<script[\s\S]*?</script>", " ", s, flags=re.I)
    s = re.sub(r"</(p|div|tr|li|h[1-6])>", "\n", s, flags=re.I)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    s = re.sub(r"[ \t]+", " ", s)
    return re.sub(r"\n{3,}", "\n\n", s).strip()

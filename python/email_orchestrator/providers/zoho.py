"""Zoho Mail via Zoho's official hosted MCP server (``*.zohomcp.in``).

Zoho's tools mirror its REST API: arguments go in ``path_variables`` /
``query_params`` and every call needs the numeric mailbox ``accountId``. Reading
one message also needs its ``folderId``, so we remember messageId → folderId
from list results.
"""

from __future__ import annotations

import re
from typing import Any

from ..core.normalizer import RawEmailData, normalize_email, to_iso
from ..utils.errors import ProviderConnectionError
from .base import BaseMcpAdapter

LIST_FIELDS = (
    "summary,subject,messageId,folderId,threadId,fromAddress,sender,toAddress,ccAddress,"
    "receivedTime,sentDateInGMT,status,hasAttachment,priority,size"
)


class ZohoAdapter(BaseMcpAdapter):
    def __init__(self, account) -> None:
        super().__init__(account)
        self._zoho_account_id: str | None = None
        self._inbox_folder_id: str | None = None
        self._folder_name_by_id: dict[str, str] = {}
        self._folder_id_by_name: dict[str, str] = {}
        self._folder_id_by_message: dict[str, str] = {}
        self._meta_by_message: dict[str, RawEmailData] = {}
        self._ready = False

    def preferred_tool_names(self) -> dict[str, list[str]]:
        return {
            "listEmails": ["ZohoMail_listEmails"],
            "searchEmails": ["ZohoMail_SearchEmails"],
            "getEmail": ["ZohoMail_getMessageContent"],
        }

    async def list_emails(self, options=None):
        await self._ensure_ready()
        return await super().list_emails(options)

    async def search_emails(self, query, options=None):
        await self._ensure_ready()
        return await super().search_emails(query, options)

    async def get_email(self, email_id: str):
        await self._ensure_ready()
        folder_id = self._folder_id_by_message.get(email_id) or self._inbox_folder_id
        if not folder_id:
            return None
        await self.ensure_connected()
        tool = self.resolve_tool_name("getEmail")
        try:
            parsed = await self.call_tool_raw(
                tool,
                {
                    "path_variables": {"accountId": self._zoho_account_id, "folderId": folder_id, "messageId": email_id},
                    "query_params": {"includeBlockContent": True},
                },
            )
        except Exception as e:
            self.log.warn("Zoho: getMessageContent failed", {"id": email_id, "error": str(e)})
            return None
        payload = _zoho_payload(parsed)
        html = payload.get("content") if isinstance(payload, dict) and isinstance(payload.get("content"), str) else ""
        meta = self._meta_by_message.get(email_id) or {"id": email_id, "messageId": email_id}
        merged = {**meta, "id": email_id, "messageId": email_id, "content": html_to_text(html), "bodyHtml": html}
        try:
            return normalize_email(merged, self.provider, self.account_id, self.email)
        except Exception:
            return None

    async def create_draft(self, draft):
        raise ProviderConnectionError(
            self.provider,
            "Saving drafts is not supported for Zoho with the enabled tool set "
            '(no "save draft" tool). smart_reply still returns the drafted reply text.',
            {"accountId": self.account_id},
        )

    def build_list_args(self, options: dict[str, Any]) -> dict[str, Any]:
        query_params: dict[str, Any] = {
            "fields": LIST_FIELDS,
            "limit": _clamp(options.get("maxResults")),
            "status": "unread" if options.get("unreadOnly") else "all",
        }
        folder_id = self._resolve_folder_id(options.get("folder"))
        if folder_id:
            query_params["folderId"] = folder_id
        return {"path_variables": {"accountId": self._zoho_account_id}, "query_params": query_params}

    def build_search_args(self, query: str, options: dict[str, Any]) -> dict[str, Any]:
        return {
            "path_variables": {"accountId": self._zoho_account_id},
            "query_params": {"searchKey": to_search_key(query), "limit": _clamp(options.get("maxResults"))},
        }

    def extract_email_list(self, parsed: Any) -> list[RawEmailData]:
        if _is_failure(parsed):
            self._warn_failure(parsed)
            return []
        return [self._map_item(z) for z in _zoho_array(parsed) if isinstance(z, dict)]

    def extract_email(self, parsed: Any) -> RawEmailData | None:
        if _is_failure(parsed):
            self._warn_failure(parsed)
            return None
        p = _zoho_payload(parsed)
        return self._map_item(p) if isinstance(p, dict) else None

    # ---- setup

    async def _ensure_ready(self) -> None:
        if self._ready:
            return
        await self.ensure_connected()
        self._zoho_account_id = self.connection.account_id or await self._fetch_account_id()
        if not self._zoho_account_id:
            raise ProviderConnectionError(
                self.provider,
                "Could not determine Zoho mailbox accountId. Set ZOHO_MAIL_ACCOUNT_ID, "
                "or enable the Account tool group (getMailAccounts) in the Zoho MCP console.",
                {"accountId": self.account_id},
            )
        await self._load_folders()
        self._ready = True

    async def _fetch_account_id(self) -> str | None:
        tool = next((n for n in self.discovered_tools if re.search(r"getMailAccounts", n, re.I)), None) or next(
            (n for n in self.discovered_tools if re.search(r"(getAll)?(User)?Accounts?$", n, re.I)), None
        )
        if not tool:
            return None
        parsed = await self.call_tool_raw(tool, {"path_variables": {}, "query_params": {}})
        accounts = [a for a in _zoho_array(parsed) if isinstance(a, dict)]
        chosen = next((a for a in accounts if a.get("isDefaultAccount")), accounts[0] if accounts else None)
        acc_id = chosen.get("accountId") if chosen else None
        return str(acc_id) if acc_id is not None else None

    async def _load_folders(self) -> None:
        tool = next((n for n in self.discovered_tools if re.search(r"getAllFolders", n, re.I)), None)
        if not tool or not self._zoho_account_id:
            return
        try:
            parsed = await self.call_tool_raw(
                tool,
                {
                    "path_variables": {"accountId": self._zoho_account_id},
                    "query_params": {"fields": "folderId,folderName,folderType,path"},
                },
            )
            for f in _zoho_array(parsed):
                if not isinstance(f, dict):
                    continue
                fid = str(f["folderId"]) if f.get("folderId") is not None else ""
                fname = str(f.get("folderName") or "")
                if not fid:
                    continue
                self._folder_name_by_id[fid] = fname
                if fname:
                    self._folder_id_by_name[fname.lower()] = fid
                if not self._inbox_folder_id and str(f.get("folderType")).lower() == "inbox" and fname.lower() == "inbox":
                    self._inbox_folder_id = fid
            if not self._inbox_folder_id:
                self._inbox_folder_id = self._folder_id_by_name.get("inbox")
        except Exception as e:
            self.log.warn("Zoho: failed to load folders", {"error": str(e)})

    def _resolve_folder_id(self, folder: str | None) -> str | None:
        if not folder:
            return None  # no folder => Zoho's all-folder view (catches Newsletter etc.)
        key = folder.lower()
        if key == "inbox":
            return self._inbox_folder_id or self._folder_id_by_name.get("inbox")
        return self._folder_id_by_name.get(key)

    def _map_item(self, z: dict[str, Any]) -> RawEmailData:
        message_id = str(z.get("messageId") if z.get("messageId") is not None else z.get("id") or "")
        folder_id = str(z["folderId"]) if z.get("folderId") is not None else None
        if message_id and folder_id:
            self._folder_id_by_message[message_id] = folder_id
        try:
            received_ms = float(z.get("receivedTime") or z.get("sentDateInGMT") or 0)
        except (TypeError, ValueError):
            received_ms = 0
        from datetime import datetime, timezone

        raw: RawEmailData = {
            "id": message_id,
            "messageId": message_id,
            "subject": decode_entities(str(z.get("subject") or "")),
            "from": {"name": decode_entities(str(z.get("sender") or "")), "email": clean_address(z.get("fromAddress"))},
            "to": clean_address_list(z.get("toAddress")),
            "cc": clean_address_list(z.get("ccAddress")),
            "date": to_iso(datetime.fromtimestamp(received_ms / 1000, tz=timezone.utc)) if received_ms > 0 else None,
            "snippet": decode_entities(str(z.get("summary") or "")),
            "isRead": str(z.get("status") if z.get("status") is not None else "") != "0",
            "hasAttachments": str(z.get("hasAttachment") if z.get("hasAttachment") is not None else "0") == "1",
            "folder": (self._folder_name_by_id.get(folder_id) or folder_id) if folder_id else None,
            "threadId": str(z["threadId"]) if z.get("threadId") is not None else None,
        }
        if message_id:
            self._meta_by_message[message_id] = raw
        return raw

    def _warn_failure(self, parsed: Any) -> None:
        d = parsed.get("data") if isinstance(parsed, dict) else None
        d = d if isinstance(d, dict) else {}
        inner = d.get("data") if isinstance(d.get("data"), dict) else {}
        status = d.get("status") if isinstance(d.get("status"), dict) else {}
        msg = inner.get("message") or d.get("message") or status.get("description") or "unknown error"
        self.log.warn("Zoho tool returned failure", {"message": str(msg)[:200]})


# ---- Zoho envelope helpers: responses look like {"status": ..., "data": {"data": [...]}}


def _zoho_data(parsed: Any) -> Any:
    if isinstance(parsed, dict):
        data = parsed.get("data")
        if isinstance(data, dict) and "data" in data:
            return data["data"]
        if isinstance(data, list):
            return data
        return data if data is not None else parsed
    return parsed


def _zoho_array(parsed: Any) -> list[Any]:
    d = _zoho_data(parsed)
    if isinstance(d, list):
        return d
    return [d] if isinstance(d, dict) else []


def _zoho_payload(parsed: Any) -> Any:
    d = _zoho_data(parsed)
    return (d[0] if d else None) if isinstance(d, list) else d


def _is_failure(parsed: Any) -> bool:
    if not isinstance(parsed, dict):
        return False
    if parsed.get("status") == "failure":
        return True
    data = parsed.get("data")
    status = data.get("status") if isinstance(data, dict) else None
    code = status.get("code") if isinstance(status, dict) else None
    return isinstance(code, (int, float)) and not isinstance(code, bool) and code >= 400


def _clamp(n: int | None) -> int:
    return min(max(n or 25, 1), 200)


def to_search_key(query: str) -> str:
    q = query.strip()
    if not q:
        return "entire:"
    if re.match(r"^[a-zA-Z]+:", q) or "::" in q or ":or:" in q:
        return q  # already Zoho search syntax
    return f"entire:{q}"


def decode_entities(s: str) -> str:
    s = s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
    s = re.sub(r"&#0?39;", "'", s).replace("&apos;", "'").replace("&nbsp;", " ")
    return s.replace("&amp;", "&")  # last, so "&amp;lt;" becomes "&lt;" not "<"


def _strip_address(part: str) -> str:
    part = re.sub(r"^[^<]*<\s*", "", part)
    part = re.sub(r"\s*>.*$", "", part)
    return re.sub(r"[<>]", "", part).strip()


def clean_address(v: Any) -> str:
    if v is None:
        return ""
    s = decode_entities(str(v)).strip()
    if not s or re.fullmatch(r"not provided", s, re.I):
        return ""
    return _strip_address(s)


def clean_address_list(v: Any) -> list[dict[str, str]]:
    if v is None:
        return []
    s = decode_entities(str(v)).strip()
    if not s or re.fullmatch(r"not provided", s, re.I):
        return []
    return [{"name": "", "email": e} for e in (_strip_address(p) for p in s.split(",")) if e]


def html_to_text(html: str) -> str:
    if not html:
        return ""
    s = re.sub(r"<style[\s\S]*?</style>", " ", html, flags=re.I)
    s = re.sub(r"<script[\s\S]*?</script>", " ", s, flags=re.I)
    s = re.sub(r"</(p|div|tr|li|h[1-6])>", "\n", s, flags=re.I)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = decode_entities(s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()

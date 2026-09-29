"""Turn each provider's raw email shape into one ``NormalizedEmail`` dict.

Analogy: a travel adaptor. Gmail, Zoho, IMAP and Graph each have a differently
shaped "plug" (field names, date formats, contact formats). The normalizer is the
adaptor that makes every one of them fit the same socket, so the AI and tool
layers never care which provider an email came from.
"""

from __future__ import annotations

import base64
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

from ..utils.errors import ValidationError
from ..utils.logger import logger

_log = logger.child("normalizer")

RawEmailData = dict[str, Any]


def iso_now() -> str:
    return to_iso(datetime.now(timezone.utc))


def to_iso(dt: datetime) -> str:
    """Format like JavaScript's ``Date.toISOString()``: ``2026-08-10T09:30:00.000Z``."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def parse_date(value: Any) -> datetime | None:
    """Best-effort date parsing: ISO-8601, RFC-2822 (email headers), or epoch millis."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value) / 1000, tz=timezone.utc)
    s = str(value).strip()
    if re.fullmatch(r"\d{10,13}", s):
        n = int(s)
        return datetime.fromtimestamp(n / 1000 if len(s) == 13 else n, tz=timezone.utc)
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        pass
    try:
        dt = parsedate_to_datetime(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError, IndexError):
        return None


def date_ms(value: Any) -> float | None:
    dt = parse_date(value)
    return dt.timestamp() * 1000 if dt else None


def _str(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _first(raw: RawEmailData, *keys: str) -> Any:
    """JavaScript ``a ?? b ?? c``: first value that is not None/missing."""
    for k in keys:
        v = raw.get(k)
        if v is not None:
            return v
    return None


def parse_contact(raw: Any) -> dict[str, str]:
    if isinstance(raw, str):
        m = re.match(r"^(.+?)\s*<(.+)>$", raw)
        if m:
            return {"name": m.group(1).strip().strip('"'), "email": m.group(2).strip()}
        return {"name": raw, "email": raw}
    if isinstance(raw, dict):
        return {
            "name": _str(_first(raw, "name", "displayName", "emailAddress")),
            "email": _str(_first(raw, "email", "emailAddress", "address")),
        }
    return {"name": "", "email": ""}


def parse_contacts(raw: Any) -> list[dict[str, str]]:
    if not raw:
        return []
    if isinstance(raw, str):
        return [parse_contact(s.strip()) for s in raw.split(",")]
    if isinstance(raw, list):
        return [parse_contact(x) for x in raw]
    return [parse_contact(raw)]


def _parse_attachments(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out = []
    for i, item in enumerate(raw):
        obj = item if isinstance(item, dict) else {}
        try:
            size = int(float(_first(obj, "size", "fileSize") or 0))
        except (TypeError, ValueError):
            size = 0
        out.append(
            {
                "id": _str(_first(obj, "id", "attachmentId") or f"attachment-{i}"),
                "filename": _str(_first(obj, "filename", "name", "fileName") or "unknown"),
                "mimeType": _str(_first(obj, "mimeType", "contentType") or "application/octet-stream"),
                "size": size,
            }
        )
    return out


def _extract_body(raw: RawEmailData) -> str:
    for f in ("body", "content", "text", "textBody", "plainText", "snippet"):
        v = raw.get(f)
        if isinstance(v, str) and v:
            return v
    payload = raw.get("payload")
    if isinstance(payload, dict):
        body = payload.get("body")
        if isinstance(body, dict) and isinstance(body.get("data"), str):
            data = body["data"]
            try:  # Gmail API returns base64url bodies
                return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", "replace")
            except Exception:
                return data
    return _str(raw.get("snippet"))


def _extract_html(raw: RawEmailData) -> str | None:
    for f in ("bodyHtml", "htmlBody", "htmlContent", "html"):
        v = raw.get(f)
        if isinstance(v, str) and v:
            return v
    return None


def normalize_email(raw: RawEmailData, provider: str, account_id: str, account_email: str) -> dict[str, Any]:
    email_id = _str(_first(raw, "id", "messageId", "uid"))
    if not email_id:
        raise ValidationError("Email missing required ID field", {"raw": str(raw)[:200]})

    subject = _str(_first(raw, "subject", "Subject") or "(No Subject)")
    parsed = parse_date(_first(raw, "date", "receivedDateTime", "receivedDate", "internalDate"))
    date = to_iso(parsed) if parsed else iso_now()

    label_ids = raw.get("labelIds") if isinstance(raw.get("labelIds"), list) else []
    is_read = _first(raw, "isRead", "read")
    labels = _first(raw, "labels", "labelIds", "categories")

    email: dict[str, Any] = {
        "id": email_id,
        "globalId": f"{account_id}:{email_id}",
        "provider": provider,
        "accountId": account_id,
        "accountEmail": account_email,
        "from": parse_contact(_first(raw, "from", "sender", "fromAddress")),
        "to": parse_contacts(_first(raw, "to", "toAddress", "toRecipients")),
        "cc": parse_contacts(_first(raw, "cc", "ccAddress", "ccRecipients")),
        "bcc": parse_contacts(_first(raw, "bcc", "bccAddress", "bccRecipients")),
        "subject": subject,
        "date": date,
        "receivedAt": date,
        "snippet": _str(_first(raw, "snippet", "bodyPreview"))[:200],
        "body": _extract_body(raw),
        "isRead": bool(is_read) if is_read is not None else "UNREAD" not in label_ids,
        "isStarred": bool(_first(raw, "isStarred", "isFlagged", "flagged") or "STARRED" in label_ids),
        "isDraft": bool(_first(raw, "isDraft", "draft") or "DRAFT" in label_ids),
        "labels": labels if isinstance(labels, list) else [],
        "folder": _str(_first(raw, "folder", "folderId", "parentFolderId") or "INBOX"),
        "hasAttachments": bool(
            _first(raw, "hasAttachments", "hasAttachment")
            or (isinstance(raw.get("attachments"), list) and len(raw["attachments"]) > 0)
        ),
        "attachments": _parse_attachments(raw.get("attachments")),
    }
    if raw.get("replyTo"):
        email["replyTo"] = parse_contact(raw["replyTo"])
    html = _extract_html(raw)
    if html:
        email["bodyHtml"] = html
    if raw.get("threadId"):
        email["threadId"] = _str(raw["threadId"])
    if raw.get("inReplyTo"):
        email["inReplyTo"] = _str(raw["inReplyTo"])
    if isinstance(raw.get("references"), list):
        email["references"] = raw["references"]
    return email


def normalize_emails(raws: list[RawEmailData], provider: str, account_id: str, account_email: str) -> list[dict[str, Any]]:
    out = []
    for raw in raws:
        try:
            out.append(normalize_email(raw, provider, account_id, account_email))
        except Exception as e:  # one malformed row must not sink the whole batch
            _log.warn("Skipping email that failed normalization", {"error": str(e)})
    _log.debug(f"Normalized {len(out)}/{len(raws)} emails", {"provider": provider, "accountId": account_id})
    return out

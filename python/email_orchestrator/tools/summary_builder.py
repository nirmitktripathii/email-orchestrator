"""Pure functions: enriched emails → InboxSummary / DailyDigest and chat text.

"Pure" means: same input, same output, no network, no clock except the
``generatedAt`` stamp — which makes them trivial to unit-test.
"""

from __future__ import annotations

import re
from typing import Any

from ..core.normalizer import iso_now

CATEGORY_EMOJI: dict[str, str] = {
    "urgent": "🔴",
    "follow-up": "🟡",
    "promotional": "📢",
    "hr-employee": "👔",
    "financial": "💳",
    "informational": "🟢",
    "personal": "👤",
    "spam": "🚫",
    "uncategorized": "⚪",
}

ALL_CATEGORIES: tuple[str, ...] = (
    "urgent", "follow-up", "hr-employee", "financial",
    "personal", "informational", "promotional", "spam", "uncategorized",
)


def _enr(email: dict[str, Any]) -> dict[str, Any]:
    return email.get("aiEnrichment") or {}


def _cat(email: dict[str, Any]) -> str:
    return _enr(email).get("category") or "uncategorized"


def _urg(email: dict[str, Any]) -> float:
    return _enr(email).get("urgencyScore") or 0


def first_line(text: str | None) -> str:
    if not text:
        return ""
    line = next((s.strip() for s in text.split("\n") if s.strip()), "")
    return re.sub(r"^[•\-*]\s*", "", line)


def truncate(text: str, max_len: int) -> str:
    return text if len(text) <= max_len else f"{text[: max_len - 1]}…"


def to_highlight(email: dict[str, Any]) -> dict[str, Any]:
    one_liner = first_line(_enr(email).get("summary")) or email.get("snippet") or email["subject"]
    return {
        "globalId": email["globalId"],
        "accountEmail": email["accountEmail"],
        "subject": email["subject"],
        "from": email["from"]["name"] or email["from"]["email"],
        "date": email["date"],
        "category": _cat(email),
        "urgencyScore": _urg(email),
        "oneLiner": truncate(one_liner, 140),
    }


def category_breakdown(emails: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts: dict[str, list[int]] = {}
    for e in emails:
        entry = counts.setdefault(_cat(e), [0, 0])
        entry[0] += 1
        if not e["isRead"]:
            entry[1] += 1
    return [{"category": c, "count": counts[c][0], "unreadCount": counts[c][1]} for c in ALL_CATEGORIES if c in counts]


def account_summaries(emails: list[dict[str, Any]], statuses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_account: dict[str, list[int]] = {}
    for e in emails:
        entry = by_account.setdefault(e["accountId"], [0, 0])
        entry[0] += 1
        if not e["isRead"]:
            entry[1] += 1
    out = []
    for s in statuses:
        total, unread = by_account.get(s["accountId"], [0, 0])
        out.append({**s, "totalEmails": total, "unreadCount": unread})
    return out


def urgent_items(emails: list[dict[str, Any]], limit: int = 10) -> list[dict[str, Any]]:
    picked = [e for e in emails if _urg(e) >= 7 or _cat(e) == "urgent"]
    picked.sort(key=_urg, reverse=True)  # stable, like JS Array.sort
    return [to_highlight(e) for e in picked[:limit]]


def action_required_items(emails: list[dict[str, Any]], limit: int = 15) -> list[dict[str, Any]]:
    picked = [e for e in emails if _enr(e).get("requiresResponse") or _cat(e) == "follow-up"]
    picked.sort(key=_urg, reverse=True)
    return [to_highlight(e) for e in picked[:limit]]


def build_inbox_summary(emails: list[dict[str, Any]], statuses: list[dict[str, Any]], digest: str) -> dict[str, Any]:
    return {
        "generatedAt": iso_now(),
        "accounts": account_summaries(emails, statuses),
        "totalEmails": len(emails),
        "totalUnread": sum(1 for e in emails if not e["isRead"]),
        "categoryBreakdown": category_breakdown(emails),
        "urgentItems": urgent_items(emails),
        "actionRequired": action_required_items(emails),
        "digest": digest,
    }


def build_daily_digest(
    emails: list[dict[str, Any]], statuses: list[dict[str, Any]], narrative: str, period: dict[str, str]
) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = {c: [] for c in ALL_CATEGORIES}
    for e in emails:
        grouped[_cat(e)].append(to_highlight(e))
    return {
        "generatedAt": iso_now(),
        "period": period,
        "summary": build_inbox_summary(emails, statuses, narrative),
        "newEmailCount": len(emails),
        "topPriorityEmails": urgent_items(emails, 5),
        "categorizedEmails": grouped,
        "narrativeSummary": narrative,
    }


# ---------------------------------------------------------------- chat text


def format_inbox_summary_text(summary: dict[str, Any], digest: str) -> str:
    lines = [
        f"📬 Inbox Overview — {summary['totalEmails']} emails ({summary['totalUnread']} unread) "
        f"across {len(summary['accounts'])} account(s)",
        "",
    ]
    if summary["categoryBreakdown"]:
        parts = [
            f"{CATEGORY_EMOJI[c['category']]} {c['count']} {c['category']}"
            + (f" ({c['unreadCount']} unread)" if c["unreadCount"] > 0 else "")
            for c in summary["categoryBreakdown"]
        ]
        lines += [f"Breakdown: {' · '.join(parts)}", ""]
    if summary["urgentItems"]:
        lines.append("🔴 Urgent / time-sensitive:")
        for item in summary["urgentItems"]:
            lines.append(f"  • [{item['urgencyScore']}/10] {item['subject']} — {item['from']} ({item['accountEmail']})")
            if item["oneLiner"]:
                lines.append(f"      {item['oneLiner']}")
        lines.append("")
    if summary["actionRequired"]:
        lines.append("🟡 Needs a response / follow-up:")
        for item in summary["actionRequired"]:
            lines.append(f"  • {item['subject']} — {item['from']} ({item['accountEmail']})")
        lines.append("")
    if digest:
        lines += ["📝 Summary:", digest]
    return "\n".join(lines).strip()


def format_account_status_text(statuses: list[dict[str, Any]]) -> str:
    if not statuses:
        return "No email accounts are configured."
    lines = ["📡 Account status:"]
    for s in statuses:
        dot = "🟢 connected" if s.get("isConnected") else "🔴 disconnected"
        synced = f" · last synced {s['lastSyncedAt']}" if s.get("lastSyncedAt") else ""
        lines.append(f"  • {s.get('accountEmail') or s['accountId']} [{s['provider']}] — {dot}{synced}")
    return "\n".join(lines)

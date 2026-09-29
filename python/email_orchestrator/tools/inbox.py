"""Cross-account inbox tools: inbox_summary, daily_digest, search_all, prioritize_inbox."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from ..core.normalizer import iso_now, to_iso
from .context import (
    ToolContext,
    ToolDefinition,
    ToolOutput,
    optional_bool,
    optional_int,
    optional_number,
    optional_string,
    require_string,
)
from .summary_builder import (
    CATEGORY_EMOJI,
    build_daily_digest,
    build_inbox_summary,
    format_inbox_summary_text,
    to_highlight,
)


def _ago(**delta: float) -> str:
    return to_iso(datetime.now(timezone.utc) - timedelta(**delta))


def since_from_days(days: float) -> str | None:
    return _ago(days=days) if days and days > 0 else None


def parse_level(value: str | None, fallback: str) -> str:
    return value if value in ("category", "summary", "full") else fallback


def _urgency(e: dict[str, Any]) -> float:
    return (e.get("aiEnrichment") or {}).get("urgencyScore") or 0


def format_email_list(emails: list[dict[str, Any]], show_rank: bool) -> str:
    if not emails:
        return "No matching emails found."
    lines = []
    for i, e in enumerate(emails):
        enr = e.get("aiEnrichment")
        cat = f"{CATEGORY_EMOJI[enr['category']]} {enr['category']}" if enr else ""
        urg = f" [{enr['urgencyScore']}/10]" if enr else ""
        rank = f"{i + 1}. " if show_rank else "• "
        unread = "" if e["isRead"] else " ✉️"
        who = e["from"]["name"] or e["from"]["email"]
        lines.append(f"{rank}{cat}{urg} {e['subject']}{unread}\n     {who} · {e['accountEmail']} · {e['date']}")
    return "\n".join(lines)


_LEVEL_SCHEMA_DESC = (
    'Depth of AI analysis. "category" is fastest; "summary" adds bullet summaries; '
    '"full" adds actions/tasks. Default "summary".'
)


async def _inbox_summary(args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
    max_per_account = optional_int(args, "maxPerAccount", 25)
    unread_only = optional_bool(args, "unreadOnly", False)
    since = since_from_days(optional_number(args, "sinceDays", 0))
    level = parse_level(optional_string(args, "enrichLevel"), "summary")
    include_digest = optional_bool(args, "includeDigest", True)

    options: dict[str, Any] = {"maxResults": max_per_account, "unreadOnly": unread_only}
    if since:
        options["since"] = since
    raw = await ctx.providers.list_all_emails(options)
    enriched = await ctx.enrichment.enrich_many(raw, level)
    digest = (await ctx.summarizer.generate_digest(enriched))["digest"] if include_digest else ""
    summary = build_inbox_summary(enriched, ctx.providers.get_statuses(), digest)
    return ToolOutput(format_inbox_summary_text(summary, digest), summary)


async def _daily_digest(args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
    since_hours = optional_number(args, "sinceHours", 24)
    max_per_account = optional_int(args, "maxPerAccount", 50)
    level = parse_level(optional_string(args, "enrichLevel"), "summary")

    start, end = _ago(hours=since_hours), iso_now()
    raw = await ctx.providers.list_all_emails({"maxResults": max_per_account, "since": start})
    enriched = await ctx.enrichment.enrich_many(raw, level)
    d = await ctx.summarizer.generate_digest(enriched)
    narrative = "\n".join(
        p
        for p in (
            d["digest"],
            "\nTop priorities:\n- " + "\n- ".join(d["topPriorities"]) if d["topPriorities"] else "",
            f"\nAction plan: {d['actionPlan']}" if d["actionPlan"] else "",
        )
        if p
    )
    daily = build_daily_digest(enriched, ctx.providers.get_statuses(), narrative, {"from": start, "to": end})
    return ToolOutput(format_inbox_summary_text(daily["summary"], narrative), daily)


async def _search_all(args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
    query = require_string(args, "query")
    max_results = optional_int(args, "maxResults", 25)
    enrich = optional_bool(args, "enrich", False)

    results = await ctx.providers.search_all(query, {"maxResults": max_results})
    if enrich:
        results = await ctx.enrichment.enrich_many(results, "category")
    else:
        ctx.enrichment.remember_emails(results)
    text = f'🔎 Search "{query}" — {len(results)} result(s):\n\n{format_email_list(results, False)}'
    return ToolOutput(text, {"query": query, "count": len(results), "results": [to_highlight(e) for e in results]})


async def _prioritize_inbox(args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
    max_per_account = optional_int(args, "maxPerAccount", 40)
    unread_only = optional_bool(args, "unreadOnly", True)
    limit = optional_int(args, "limit", 20)

    raw = await ctx.providers.list_all_emails({"maxResults": max_per_account, "unreadOnly": unread_only})
    enriched = await ctx.enrichment.enrich_many(raw, "category")
    ranked = sorted(enriched, key=_urgency, reverse=True)[:limit]
    text = f"📊 Prioritized inbox ({len(ranked)} of {len(enriched)}):\n\n{format_email_list(ranked, True)}"
    return ToolOutput(text, [to_highlight(e) for e in ranked])


INBOX_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="inbox_summary",
        description=(
            "AI-powered summary across ALL connected email accounts: total counts, per-category breakdown "
            "(urgent, follow-up, promotional, HR, financial, informational, personal, spam), urgent highlights, "
            "items needing a response, and a narrative digest. This is the main \"what's in my inbox right now\" tool."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "maxPerAccount": {"type": "number", "description": "Max emails to pull per account (default 25)."},
                "unreadOnly": {"type": "boolean", "description": "Only include unread emails (default false)."},
                "sinceDays": {"type": "number", "description": "Only include emails from the last N days."},
                "enrichLevel": {"type": "string", "enum": ["category", "summary", "full"], "description": _LEVEL_SCHEMA_DESC},
                "includeDigest": {"type": "boolean", "description": "Generate a narrative AI digest (default true)."},
            },
        },
        handler=_inbox_summary,
    ),
    ToolDefinition(
        name="daily_digest",
        description=(
            "Comprehensive daily email digest across all accounts for a recent time window, grouped by category "
            "with a narrative summary, top priorities, and an action plan for the day. Use for the scheduled "
            "morning/afternoon/evening rundown."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "sinceHours": {"type": "number", "description": "Look back this many hours (default 24)."},
                "maxPerAccount": {"type": "number", "description": "Max emails per account (default 50)."},
                "enrichLevel": {
                    "type": "string",
                    "enum": ["category", "summary", "full"],
                    "description": 'AI analysis depth (default "summary").',
                },
            },
        },
        handler=_daily_digest,
    ),
    ToolDefinition(
        name="search_all",
        description="Search across ALL connected email accounts simultaneously and return matching emails, newest first.",
        input_schema={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query (provider-native syntax is passed through, e.g. Gmail search operators).",
                },
                "maxResults": {"type": "number", "description": "Max results per account (default 25)."},
                "enrich": {"type": "boolean", "description": "Categorize results with AI (default false)."},
            },
            "required": ["query"],
        },
        handler=_search_all,
    ),
    ToolDefinition(
        name="prioritize_inbox",
        description=(
            "Rank unread emails across all accounts by AI-assessed urgency/importance (0-10), most urgent first. "
            'Great for "what should I deal with first".'
        ),
        input_schema={
            "type": "object",
            "properties": {
                "maxPerAccount": {"type": "number", "description": "Max unread emails to pull per account (default 40)."},
                "unreadOnly": {"type": "boolean", "description": "Restrict to unread (default true)."},
                "limit": {"type": "number", "description": "Max ranked emails to return (default 20)."},
            },
        },
        handler=_prioritize_inbox,
    ),
]

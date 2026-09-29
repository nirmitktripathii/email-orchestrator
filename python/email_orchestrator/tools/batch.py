"""Batch tools: batch_categorize, batch_summarize, filter_by_category."""

from __future__ import annotations

import asyncio
from typing import Any

from ..core.types import EMAIL_CATEGORIES
from .context import ToolContext, ToolDefinition, ToolOutput, optional_int, optional_string_array, require_string
from .summary_builder import CATEGORY_EMOJI, to_highlight


async def resolve_many(global_ids: list[str], ctx: ToolContext) -> list[dict[str, Any]]:
    """Resolve many global ids (cache-first), silently skipping any that fail."""
    settled = await asyncio.gather(
        *(ctx.enrichment.resolve_email(gid, ctx.providers) for gid in global_ids), return_exceptions=True
    )
    return [r for r in settled if not isinstance(r, BaseException)]


def _who(e: dict[str, Any]) -> str:
    return e["from"]["name"] or e["from"]["email"]


async def _pick(args: dict[str, Any], ctx: ToolContext, default_max: int) -> list[dict[str, Any]]:
    ids = optional_string_array(args, "globalIds")
    if ids:
        return await resolve_many(ids, ctx)
    return await ctx.providers.list_all_emails({"maxResults": optional_int(args, "maxPerAccount", default_max)})


async def _batch_categorize(args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
    enriched = await ctx.enrichment.enrich_many(await _pick(args, ctx, 25), "category")
    lines = []
    for e in enriched:
        enr = e.get("aiEnrichment") or {"category": "uncategorized", "urgencyScore": 0}
        lines.append(f"{CATEGORY_EMOJI[enr['category']]} [{enr['urgencyScore']}/10] {e['subject']} — {_who(e)}")
    text = "\n".join(lines) if lines else "No emails to categorize."
    return ToolOutput(text, [to_highlight(e) for e in enriched])


async def _batch_summarize(args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
    enriched = await ctx.enrichment.enrich_many(await _pick(args, ctx, 10), "summary", 3)
    text = (
        "\n\n".join(
            f"📩 {e['subject']} — {_who(e)} ({e['accountEmail']})\n"
            f"{(e.get('aiEnrichment') or {}).get('summary') or e.get('snippet') or ''}"
            for e in enriched
        )
        if enriched
        else "No emails to summarize."
    )
    data = [
        {"globalId": e["globalId"], "subject": e["subject"], "summary": (e.get("aiEnrichment") or {}).get("summary", "")}
        for e in enriched
    ]
    return ToolOutput(text, data)


async def _filter_by_category(args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
    category = require_string(args, "category")
    if category not in EMAIL_CATEGORIES:
        return ToolOutput(f"Invalid category. Valid: {', '.join(EMAIL_CATEGORIES)}", {"error": "invalid_category"})
    max_per_account = optional_int(args, "maxPerAccount", 40)

    raw = await ctx.providers.list_all_emails({"maxResults": max_per_account})
    enriched = await ctx.enrichment.enrich_many(raw, "category")
    matches = [e for e in enriched if (e.get("aiEnrichment") or {}).get("category") == category]
    if matches:
        text = f'{CATEGORY_EMOJI[category]} {len(matches)} "{category}" email(s):\n\n' + "\n".join(
            f"• [{e['aiEnrichment']['urgencyScore']}/10] {e['subject']} — {_who(e)} ({e['accountEmail']})" for e in matches
        )
    else:
        text = f'No "{category}" emails found in the last {max_per_account} per account.'
    return ToolOutput(text, [to_highlight(e) for e in matches])


_IDS = {"type": "array", "items": {"type": "string"}}

BATCH_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        "batch_categorize",
        "Categorize many emails at once. Provide globalIds to categorize specific emails, or omit them to "
        "categorize the most recent emails across all accounts.",
        {
            "type": "object",
            "properties": {
                "globalIds": {**_IDS, "description": "Specific emails to categorize (accountId:messageId)."},
                "maxPerAccount": {
                    "type": "number",
                    "description": "If globalIds omitted, how many recent emails per account (default 25).",
                },
            },
        },
        _batch_categorize,
    ),
    ToolDefinition(
        "batch_summarize",
        "Summarize many emails at once. Provide globalIds, or omit to summarize the most recent emails across all accounts.",
        {
            "type": "object",
            "properties": {
                "globalIds": {**_IDS, "description": "Specific emails to summarize (accountId:messageId)."},
                "maxPerAccount": {
                    "type": "number",
                    "description": "If globalIds omitted, how many recent emails per account (default 10).",
                },
            },
        },
        _batch_summarize,
    ),
    ToolDefinition(
        "filter_by_category",
        "Return all recent emails across all accounts that match a given category "
        "(urgent, follow-up, promotional, hr-employee, financial, informational, personal, spam).",
        {
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "enum": ["urgent", "follow-up", "promotional", "hr-employee", "financial", "informational", "personal", "spam"],
                    "description": "The category to filter by.",
                },
                "maxPerAccount": {"type": "number", "description": "How many recent emails per account to scan (default 40)."},
            },
            "required": ["category"],
        },
        _filter_by_category,
    ),
]

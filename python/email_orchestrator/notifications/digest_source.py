"""Turn the live inbox into what the scheduler pushes: a digest and the urgent set."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from ..core.normalizer import to_iso
from ..tools.context import ToolContext
from ..tools.summary_builder import CATEGORY_EMOJI, category_breakdown, urgent_items
from ..utils.logger import logger
from .scheduler import DigestNotification

_log = logger.child("digest-source")


async def produce_digest_notification(ctx: ToolContext, since_hours: int = 24) -> DigestNotification:
    since = to_iso(datetime.now(timezone.utc) - timedelta(hours=since_hours))
    raw = await ctx.providers.list_all_emails({"maxResults": 40, "since": since})
    enriched = await ctx.enrichment.enrich_many(raw, "category")

    urgent = urgent_items(enriched, 5)
    breakdown = " · ".join(f"{CATEGORY_EMOJI[c['category']]} {c['count']} {c['category']}" for c in category_breakdown(enriched))
    headline = f"📬 {len(enriched)} emails in the last {since_hours}h" + (f" · {len(urgent)} urgent" if urgent else "")
    body = "\n".join(p for p in [breakdown, *(f"🔴 {u['subject']} ({u['from']})" for u in urgent[:3])] if p)

    _log.debug("Produced digest notification", {"total": len(enriched), "urgent": len(urgent)})
    return DigestNotification(title=headline, message=body or "No new mail.", urgent_items=urgent)


async def produce_urgent_highlights(ctx: ToolContext) -> list[dict[str, Any]]:
    raw = await ctx.providers.list_all_emails({"unreadOnly": True, "maxResults": 30})
    enriched = await ctx.enrichment.enrich_many(raw, "category")
    return [h for h in urgent_items(enriched, 10) if h["urgencyScore"] >= 8]  # only genuinely high urgency

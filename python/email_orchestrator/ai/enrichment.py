"""Enrichment service: fuses categorizer + summarizer + recommender, with caching.

Analogy: a restaurant kitchen with three levels of dish.
* ``category`` — just triage (1 LLM call, cheap);
* ``summary``  — triage + a summary (2 calls);
* ``full``     — also next actions and tasks (4 calls).
Finished dishes go on a warming shelf (the LRU cache) so asking twice doesn't cook twice.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, Literal

from ..core.cache import LRUCache
from ..core.normalizer import iso_now
from ..utils.errors import get_error_message
from ..utils.logger import logger
from .action_recommender import ActionRecommender
from .categorizer import EmailCategorizer
from .summarizer import EmailSummarizer

if TYPE_CHECKING:
    from ..providers.manager import ProviderManager

_log = logger.child("enrichment")

EnrichmentLevel = Literal["category", "summary", "full"]
LEVEL_RANK: dict[str, int] = {"category": 0, "summary": 1, "full": 2}


def level_of(e: dict[str, Any]) -> str:
    """Infer the level an existing enrichment represents (avoids redundant work)."""
    if e.get("suggestedActions") or e.get("extractedTasks"):
        return "full"
    if e.get("summary"):
        return "summary"
    return "category"


def blank_enrichment() -> dict[str, Any]:
    return {
        "summary": "",
        "category": "uncategorized",
        "urgencyScore": 0,
        "priority": "none",
        "suggestedActions": [],
        "extractedTasks": [],
        "sentiment": "neutral",
        "keyTopics": [],
        "requiresResponse": False,
        "enrichedAt": iso_now(),
    }


class EmailEnrichmentService:
    def __init__(
        self,
        summarizer: EmailSummarizer,
        categorizer: EmailCategorizer,
        action_recommender: ActionRecommender,
        *,
        cache_ttl_seconds: float = 300,
        max_cache_entries: int = 2000,
    ) -> None:
        self.summarizer = summarizer
        self.categorizer = categorizer
        self.action_recommender = action_recommender
        self._email_cache: LRUCache[dict[str, Any]] = LRUCache(max_cache_entries, cache_ttl_seconds)
        # Enrichment is more expensive to produce, so keep it longer.
        self._enrichment_cache: LRUCache[dict[str, Any]] = LRUCache(max_cache_entries, cache_ttl_seconds * 4)

    # ---- email cache / resolution

    def remember_emails(self, emails: list[dict[str, Any]]) -> None:
        for e in emails:
            self._email_cache.set(e["globalId"], e)

    def get_cached_email(self, global_id: str) -> dict[str, Any] | None:
        return self._email_cache.get(global_id)

    async def resolve_email(self, global_id: str, providers: "ProviderManager") -> dict[str, Any]:
        cached = self._email_cache.get(global_id)
        if cached:
            return cached
        fetched = await providers.get_email_by_global_id(global_id)
        self._email_cache.set(global_id, fetched)
        return fetched

    # ---- enrichment

    async def enrich(self, email: dict[str, Any], level: str = "full") -> dict[str, Any]:
        cache_key = f"{email['globalId']}:{level}"
        cached = self._enrichment_cache.get(cache_key)
        if cached:
            return cached
        existing = email.get("aiEnrichment")
        if existing and LEVEL_RANK[level_of(existing)] >= LEVEL_RANK[level]:
            return existing

        _log.debug("Enriching email", {"globalId": email["globalId"], "level": level})
        cat = await self.categorizer.categorize_email(email)

        summary, key_topics, sentiment = "", [], "neutral"
        if level in ("summary", "full"):
            s = await self.summarizer.summarize_email(email)
            summary, key_topics, sentiment = s["summary"], s["keyTopics"], s["sentiment"]

        actions: list[dict[str, Any]] = []
        tasks: list[dict[str, Any]] = []
        if level == "full":
            # Give the recommender the fresh category/urgency for better suggestions.
            with_cat = {
                **email,
                "aiEnrichment": {**blank_enrichment(), "category": cat["category"], "urgencyScore": cat["urgencyScore"]},
            }
            actions, tasks = await asyncio.gather(
                self.action_recommender.suggest_actions(with_cat),
                self.action_recommender.extract_tasks(email),
            )

        enrichment: dict[str, Any] = {
            "summary": summary,
            "category": cat["category"],
            "urgencyScore": cat["urgencyScore"],
            "priority": cat["priority"],
            "suggestedActions": actions,
            "extractedTasks": tasks,
            "sentiment": sentiment,
            "keyTopics": key_topics,
            "requiresResponse": cat["requiresResponse"],
        }
        if cat.get("deadlineDetected"):
            enrichment["deadlineDetected"] = cat["deadlineDetected"]
        enrichment["enrichedAt"] = iso_now()

        self._enrichment_cache.set(cache_key, enrichment)
        return enrichment

    async def enrich_many(
        self,
        emails: list[dict[str, Any]],
        level: str = "category",
        # 4 stays under the Gemini free-tier request rate (4 = zero 429s, 8 = frequent
        # RESOURCE_EXHAUSTED). The LLM client also backs off on 429/503.
        concurrency: int = 4,
    ) -> list[dict[str, Any]]:
        if not emails:
            return []
        _log.info(f'Enriching {len(emails)} emails at level "{level}" (concurrency {concurrency})')

        async def one(email: dict[str, Any]) -> dict[str, Any]:
            try:
                return {**email, "aiEnrichment": await self.enrich(email, level)}
            except Exception as e:
                _log.warn(
                    "Enrichment failed; keeping email unenriched",
                    {"globalId": email["globalId"], "error": get_error_message(e)},
                )
                return email

        out: list[dict[str, Any]] = []
        for i in range(0, len(emails), concurrency):
            out.extend(await asyncio.gather(*(one(e) for e in emails[i : i + concurrency])))
        self.remember_emails(out)
        return out

    def get_cache_stats(self) -> dict[str, Any]:
        return {"emails": self._email_cache.stats(), "enrichments": self._enrichment_cache.stats()}

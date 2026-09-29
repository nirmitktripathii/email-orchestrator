"""Categorizer: which bucket does this email belong in, and how urgent is it?

Two layers, like a hospital triage desk:
1. the LLM (the doctor) reads the email and returns a structured verdict;
2. if the doctor is unavailable, a keyword rulebook (the triage nurse's
   checklist) still gives a sensible answer — the tool never just fails.
"""

from __future__ import annotations

import asyncio
from typing import Any, Protocol

from ..core.types import EMAIL_CATEGORIES, PRIORITY_LEVELS
from ..utils.logger import logger
from .llm_client import ChatMessage
from .prompts import SYSTEM_PROMPT, build_categorize_prompt

_log = logger.child("categorizer")


class JsonLLM(Protocol):
    async def complete_json(
        self, messages: list[ChatMessage], *, temperature: float | None = None, max_tokens: int | None = None
    ) -> Any: ...


def format_from(email: dict[str, Any]) -> str:
    return f"{email['from']['name']} <{email['from']['email']}>"


def to_number(v: Any) -> float:
    """JS ``Number(x) || 0``: numbers and numeric strings parse, everything else is 0."""
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)):
        return float(v) if v == v else 0.0  # NaN → 0
    if isinstance(v, str):
        try:
            return float(v.strip()) if v.strip() else 0.0
        except ValueError:
            return 0.0
    return 0.0


def urgency_to_priority(score: float) -> str:
    if score >= 9:
        return "critical"
    if score >= 7:
        return "high"
    if score >= 5:
        return "medium"
    if score >= 3:
        return "low"
    return "none"


def _clean_score(v: Any) -> int | float:
    n = min(10.0, max(0.0, to_number(v)))
    return int(n) if n.is_integer() else n


_RULES: list[tuple[list[str], dict[str, Any]]] = [
    (
        ["unsubscribe", "newsletter", "sale", "discount", "offer", "promotion", "deal"],
        {"category": "promotional", "urgencyScore": 1, "priority": "low", "requiresResponse": False,
         "reasoning": "Keyword match: promotional content"},
    ),
    (
        ["urgent", "asap", "immediately", "deadline today", "due today", "time sensitive"],
        {"category": "urgent", "urgencyScore": 8, "priority": "high", "requiresResponse": True,
         "reasoning": "Keyword match: urgency indicators"},
    ),
    (
        ["invoice", "payment", "billing", "receipt", "expense", "amount due"],
        {"category": "financial", "urgencyScore": 5, "priority": "medium", "requiresResponse": False,
         "reasoning": "Keyword match: financial content"},
    ),
    (
        ["hr", "appraisal", "leave", "policy", "employee", "team meeting", "standup"],
        {"category": "hr-employee", "urgencyScore": 4, "priority": "medium", "requiresResponse": False,
         "reasoning": "Keyword match: HR/employee content"},
    ),
    (
        ["please reply", "your response", "let me know", "follow up", "following up", "awaiting", "pending"],
        {"category": "follow-up", "urgencyScore": 5, "priority": "medium", "requiresResponse": True,
         "reasoning": "Keyword match: follow-up indicators"},
    ),
]


def fallback_categorization(email: dict[str, Any]) -> dict[str, Any]:
    """Rule-based categorization used when the LLM is unavailable."""
    text = f"{email['subject'].lower()} {(email.get('body') or email.get('snippet') or '').lower()}"
    for patterns, verdict in _RULES:
        if any(p in text for p in patterns):
            return {**verdict, "deadlineDetected": None}
    return {"category": "informational", "urgencyScore": 3, "priority": "low", "requiresResponse": False,
            "deadlineDetected": None, "reasoning": "Default categorization"}


class EmailCategorizer:
    def __init__(self, llm: JsonLLM) -> None:
        self.llm = llm

    async def categorize_email(self, email: dict[str, Any]) -> dict[str, Any]:
        _log.debug("Categorizing email", {"globalId": email["globalId"], "subject": email["subject"]})
        try:
            raw = await self.llm.complete_json(
                [
                    ChatMessage("system", SYSTEM_PROMPT),
                    ChatMessage(
                        "user",
                        build_categorize_prompt(
                            subject=email["subject"],
                            sender=format_from(email),
                            body=email.get("body") or email.get("snippet") or "",
                            snippet=email.get("snippet") or "",
                        ),
                    ),
                ],
                temperature=0.1,  # low temperature → consistent categories
                # gemma-4 is a THINKING model: hundreds of hidden reasoning tokens are
                # spent before any JSON. 512 was too tight in production; keep headroom.
                max_tokens=2048,
            )
            if not isinstance(raw, dict):
                raise ValueError("categorizer expected a JSON object")
            category = raw.get("category")
            priority = raw.get("priority")
            result = {
                "category": category if category in EMAIL_CATEGORIES else "uncategorized",
                "urgencyScore": _clean_score(raw.get("urgencyScore")),
                "priority": priority if priority in PRIORITY_LEVELS else urgency_to_priority(to_number(raw.get("urgencyScore"))),
                "requiresResponse": bool(raw.get("requiresResponse")),
                "deadlineDetected": raw["deadlineDetected"] if isinstance(raw.get("deadlineDetected"), str) else None,
                "reasoning": str(raw["reasoning"]) if raw.get("reasoning") is not None else "",
            }
            _log.debug(
                "Email categorized",
                {"globalId": email["globalId"], "category": result["category"], "urgency": result["urgencyScore"]},
            )
            return result
        except Exception as e:
            _log.error("Failed to categorize email", e, {"globalId": email["globalId"]})
            return fallback_categorization(email)

    async def categorize_emails(self, emails: list[dict[str, Any]], concurrency: int = 3) -> dict[str, dict[str, Any]]:
        _log.info(f"Batch categorizing {len(emails)} emails (concurrency: {concurrency})")
        results: dict[str, dict[str, Any]] = {}
        for i in range(0, len(emails), concurrency):
            batch = emails[i : i + concurrency]
            outcomes = await asyncio.gather(*(self.categorize_email(e) for e in batch), return_exceptions=True)
            for email, outcome in zip(batch, outcomes):
                if isinstance(outcome, BaseException):
                    _log.warn("Categorization failed for email", {"globalId": email["globalId"]})
                    results[email["globalId"]] = fallback_categorization(email)
                else:
                    results[email["globalId"]] = outcome
        return results

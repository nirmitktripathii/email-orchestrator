"""Summarizer: per-email bullet summaries and the multi-email digest."""

from __future__ import annotations

from typing import Any

from ..utils.logger import logger
from .categorizer import JsonLLM, format_from
from .llm_client import ChatMessage
from .prompts import SYSTEM_PROMPT, build_inbox_summary_prompt, build_summarize_prompt

_log = logger.child("summarizer")


def _obj(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("expected a JSON object")
    return raw


class EmailSummarizer:
    def __init__(self, llm: JsonLLM) -> None:
        self.llm = llm

    async def summarize_email(self, email: dict[str, Any]) -> dict[str, Any]:
        _log.debug("Summarizing email", {"globalId": email["globalId"], "subject": email["subject"]})
        try:
            result = _obj(
                await self.llm.complete_json(
                    [
                        ChatMessage("system", SYSTEM_PROMPT),
                        ChatMessage(
                            "user",
                            build_summarize_prompt(
                                subject=email["subject"],
                                sender=format_from(email),
                                to=", ".join(t["email"] for t in email.get("to") or []),
                                date=email["date"],
                                body=email.get("body") or email.get("snippet") or "",
                            ),
                        ),
                    ],
                    temperature=0.2,
                    max_tokens=2048,  # thinking-model headroom (see categorizer)
                )
            )
            _log.debug("Email summarized", {"globalId": email["globalId"]})
            return {
                "summary": result["summary"] if result.get("summary") is not None else "(Summary unavailable)",
                "keyTopics": result["keyTopics"] if isinstance(result.get("keyTopics"), list) else [],
                "sentiment": result.get("sentiment") or "neutral",
            }
        except Exception as e:
            _log.error("Failed to summarize email", e, {"globalId": email["globalId"]})
            return {
                "summary": f"Subject: {email['subject']}\nFrom: {email['from']['name']}\nPreview: {email.get('snippet') or ''}",
                "keyTopics": [],
                "sentiment": "neutral",
            }

    async def generate_digest(self, emails: list[dict[str, Any]]) -> dict[str, Any]:
        if not emails:
            return {
                "digest": "📭 No emails to summarize. Your inbox is clean!",
                "topPriorities": [],
                "actionPlan": "No actions needed.",
            }
        _log.info(f"Generating digest for {len(emails)} emails")
        try:
            items = [
                {
                    "subject": e["subject"],
                    "from": format_from(e),
                    "category": (e.get("aiEnrichment") or {}).get("category") or "uncategorized",
                    "urgencyScore": (e.get("aiEnrichment") or {}).get("urgencyScore") or 0,
                    "snippet": e.get("snippet") or "",
                    "date": e["date"],
                    "accountEmail": e["accountEmail"],
                }
                for e in emails
            ]
            result = _obj(
                await self.llm.complete_json(
                    [ChatMessage("system", SYSTEM_PROMPT), ChatMessage("user", build_inbox_summary_prompt(items))],
                    temperature=0.3,
                    max_tokens=2048,
                )
            )
            return {
                "digest": result["digest"] if result.get("digest") is not None else "Digest generation failed.",
                "topPriorities": result["topPriorities"] if isinstance(result.get("topPriorities"), list) else [],
                "actionPlan": result.get("actionPlan") or "",
            }
        except Exception as e:
            _log.error("Failed to generate digest", e)
            return self._fallback_digest(emails)

    @staticmethod
    def _fallback_digest(emails: list[dict[str, Any]]) -> dict[str, Any]:
        unread = sum(1 for e in emails if not e["isRead"])
        by_category: dict[str, int] = {}
        for e in emails:
            cat = (e.get("aiEnrichment") or {}).get("category") or "uncategorized"
            by_category[cat] = by_category.get(cat, 0) + 1
        category_lines = "\n".join(f"  • {cat}: {n}" for cat, n in by_category.items())
        return {
            "digest": f"📊 Inbox Overview\n\nTotal emails: {len(emails)}\nUnread: {unread}\n\nBy Category:\n{category_lines}",
            "topPriorities": [
                f"{e['subject']} (from {e['from']['name']})"
                for e in emails
                if ((e.get("aiEnrichment") or {}).get("urgencyScore") or 0) >= 7
            ][:3],
            "actionPlan": "Review urgent emails first, then follow-ups.",
        }

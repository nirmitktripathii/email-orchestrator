"""Action recommender: suggested next steps, task extraction, reply drafts, explanations."""

from __future__ import annotations

from typing import Any

from ..utils.logger import logger
from .categorizer import JsonLLM, format_from
from .llm_client import ChatMessage
from .prompts import (
    SYSTEM_PROMPT,
    build_explain_email_prompt,
    build_extract_tasks_prompt,
    build_smart_reply_prompt,
    build_suggest_actions_prompt,
)

_log = logger.child("action-recommender")


def _body(email: dict[str, Any]) -> str:
    return email.get("body") or email.get("snippet") or ""


def _to(email: dict[str, Any]) -> str:
    return ", ".join(t["email"] for t in email.get("to") or [])


def _obj(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("expected a JSON object")
    return raw


class ActionRecommender:
    def __init__(self, llm: JsonLLM) -> None:
        self.llm = llm

    async def _ask(self, prompt: str, temperature: float, max_tokens: int) -> dict[str, Any]:
        return _obj(
            await self.llm.complete_json(
                [ChatMessage("system", SYSTEM_PROMPT), ChatMessage("user", prompt)],
                temperature=temperature,
                max_tokens=max_tokens,
            )
        )

    async def suggest_actions(self, email: dict[str, Any]) -> list[dict[str, Any]]:
        _log.debug("Suggesting actions", {"globalId": email["globalId"]})
        enrichment = email.get("aiEnrichment") or {}
        try:
            raw = await self._ask(
                build_suggest_actions_prompt(
                    subject=email["subject"],
                    sender=format_from(email),
                    to=_to(email),
                    body=_body(email),
                    category=enrichment.get("category") or "uncategorized",
                    urgency_score=enrichment["urgencyScore"] if enrichment.get("urgencyScore") is not None else 5,
                ),
                0.3,
                1024,
            )
            actions = raw.get("suggestedActions")
            return actions if isinstance(actions, list) else []
        except Exception as e:
            _log.error("Failed to suggest actions", e, {"globalId": email["globalId"]})
            return [
                {
                    "type": "reply",
                    "description": "Review and respond to this email",
                    "priority": "medium",
                    "reasoning": "Default suggestion — AI action recommendation unavailable",
                }
            ]

    async def extract_tasks(self, email: dict[str, Any]) -> list[dict[str, Any]]:
        _log.debug("Extracting tasks", {"globalId": email["globalId"]})
        try:
            raw = await self._ask(
                build_extract_tasks_prompt(subject=email["subject"], sender=format_from(email), body=_body(email)),
                0.2,
                1024,
            )
            tasks = raw.get("tasks")
            return tasks if isinstance(tasks, list) else []
        except Exception as e:
            _log.error("Failed to extract tasks", e, {"globalId": email["globalId"]})
            return []

    async def generate_smart_reply(
        self, email: dict[str, Any], recipient_name: str, *, tone: str | None = None, intent: str | None = None
    ) -> dict[str, str]:
        _log.debug("Generating smart reply", {"globalId": email["globalId"]})
        try:
            result = await self._ask(
                build_smart_reply_prompt(
                    subject=email["subject"],
                    sender=format_from(email),
                    body=_body(email),
                    recipient_name=recipient_name,
                    tone=tone,
                    intent=intent,
                ),
                0.5,
                1024,
            )
            return {
                "subject": result["subject"] if result.get("subject") is not None else f"Re: {email['subject']}",
                "body": result.get("body") or "",
                "tone": result.get("tone") or tone or "professional",
                "notes": result.get("notes") or "",
            }
        except Exception as e:
            _log.error("Failed to generate smart reply", e, {"globalId": email["globalId"]})
            return {
                "subject": f"Re: {email['subject']}",
                "body": "Thank you for your email. I will review and get back to you shortly.",
                "tone": "professional",
                "notes": "Auto-generated fallback reply — AI was unavailable.",
            }

    async def explain_email(self, email: dict[str, Any]) -> dict[str, Any]:
        _log.debug("Explaining email", {"globalId": email["globalId"]})
        try:
            result = await self._ask(
                build_explain_email_prompt(subject=email["subject"], sender=format_from(email), to=_to(email), body=_body(email)),
                0.3,
                2048,
            )
            lst = lambda k: result[k] if isinstance(result.get(k), list) else []  # noqa: E731
            return {
                "explanation": result["explanation"] if result.get("explanation") is not None else "Explanation unavailable.",
                "keyFacts": lst("keyFacts"),
                "implications": lst("implications"),
                "expectedActions": lst("expectedActions"),
            }
        except Exception as e:
            _log.error("Failed to explain email", e, {"globalId": email["globalId"]})
            return {
                "explanation": f'This email is from {email["from"]["name"]} regarding "{email["subject"]}".',
                "keyFacts": [f"From: {email['from']['email']}", f"Date: {email['date']}"],
                "implications": [],
                "expectedActions": ["Review the email content"],
            }

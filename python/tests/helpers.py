"""Shared fixtures and fakes (port of tests/helpers.ts). Not a test file itself."""

from __future__ import annotations

import itertools
import json
from datetime import datetime, timezone
from typing import Any, Callable

from email_orchestrator.ai.llm_client import ChatMessage

_counter = itertools.count(1)


def make_email(**over: Any) -> dict[str, Any]:
    n = next(_counter)
    email_id = over.get("id", f"m{n}")
    account_id = over.get("accountId", "acct")
    now = datetime.now(timezone.utc).isoformat()
    base: dict[str, Any] = {
        "id": email_id,
        "provider": "gmail",
        "accountId": account_id,
        "accountEmail": "me@example.com",
        "from": {"name": "Sender", "email": "sender@example.com"},
        "to": [{"name": "Me", "email": "me@example.com"}],
        "cc": [],
        "bcc": [],
        "subject": "Test subject",
        "date": now,
        "receivedAt": now,
        "snippet": "a short preview",
        "body": "the body of the email",
        "isRead": False,
        "isStarred": False,
        "isDraft": False,
        "labels": [],
        "folder": "INBOX",
        "hasAttachments": False,
        "attachments": [],
    }
    return {**base, **over, "globalId": f"{account_id}:{email_id}"}


Handler = Callable[[list[ChatMessage]], Any]


class FakeLLM:
    """Routes every complete_json call through one handler and counts calls."""

    def __init__(self, handler: Handler) -> None:
        self.handler = handler
        self.calls = 0

    async def complete_json(
        self, messages: list[ChatMessage], *, temperature: float | None = None, max_tokens: int | None = None
    ) -> Any:
        self.calls += 1
        return self.handler(messages)

    async def complete(self, messages: list[ChatMessage], **_: Any) -> Any:
        self.calls += 1
        return json.dumps(self.handler(messages))


def raising(message: str) -> Handler:
    def handler(_messages: list[ChatMessage]) -> Any:
        raise RuntimeError(message)

    return handler


def default_ai_handler(messages: list[ChatMessage]) -> Any:
    """Returns sensible shapes for every prompt the engines send."""
    text = "\n".join(m.content for m in messages).lower()
    if "categorize the following email" in text:
        return {"category": "urgent", "urgencyScore": 9, "priority": "critical", "requiresResponse": True,
                "deadlineDetected": None, "reasoning": "deadline today"}
    if "extract all actionable tasks" in text:
        return {"tasks": [{"description": "do the thing", "priority": "high", "source": "body"}]}
    if "summarize the following email" in text:
        return {"summary": "• first point\n• second point\n• third point", "keyTopics": ["project", "deadline"],
                "sentiment": "neutral"}
    if "suggest 1-3 appropriate actions" in text:
        return {"suggestedActions": [{"type": "reply", "description": "Reply promptly", "priority": "high",
                                      "reasoning": "needs a response"}]}
    if "comprehensive inbox summary" in text:
        return {"digest": "You have urgent items to handle.", "topPriorities": ["Handle urgent email"],
                "actionPlan": "Start with urgent."}
    if "draft a" in text:
        return {"subject": "Re: Test subject", "body": "Thanks, will do.", "tone": "professional", "notes": ""}
    if "detailed explanation" in text:
        return {"explanation": "This email is about X.", "keyFacts": ["fact"], "implications": ["impl"],
                "expectedActions": ["act"]}
    return {}


class FakeAdapter:
    """A provider adapter backed by an in-memory list of emails."""

    provider = "gmail"

    def __init__(self, account_id: str, email: str, emails: list[dict[str, Any]], *, fail_on_list: bool = False) -> None:
        self.account_id = account_id
        self.email = email
        self.display_name = f"{account_id} ({email})"
        self.emails = emails
        self.fail_on_list = fail_on_list
        self._connected = False

    async def connect(self) -> None:
        self._connected = True

    async def disconnect(self) -> None:
        self._connected = False

    async def ensure_connected(self) -> None:
        self._connected = True

    def is_connected(self) -> bool:
        return self._connected

    async def list_emails(self, options: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        options = options or {}
        if self.fail_on_list:
            raise RuntimeError("simulated list failure")
        out = self.emails
        if options.get("unreadOnly"):
            out = [e for e in out if not e["isRead"]]
        if options.get("maxResults"):
            out = out[: options["maxResults"]]
        return out

    async def search_emails(self, query: str, options: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        return [e for e in self.emails if query.lower() in e["subject"].lower()]

    async def get_email(self, email_id: str) -> dict[str, Any] | None:
        return next((e for e in self.emails if e["id"] == email_id), None)

    async def create_draft(self, draft: dict[str, Any]) -> dict[str, str]:
        return {"draftId": "draft-1", "accountId": self.account_id, "provider": self.provider}

    def get_status(self) -> dict[str, Any]:
        return {
            "accountId": self.account_id,
            "accountEmail": self.email,
            "provider": self.provider,
            "totalEmails": len(self.emails),
            "unreadCount": sum(1 for e in self.emails if not e["isRead"]),
            "isConnected": self._connected,
        }

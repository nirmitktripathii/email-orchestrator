"""Shared types.

Two families, deliberately different:

* **Wire data** (emails, AI enrichment, summaries) are plain ``dict``s described by
  ``TypedDict``s with camelCase keys. They travel as JSON to Claude and back from
  the LLM, so keeping them JSON-shaped avoids a conversion layer at every edge.
* **Internal config** (accounts, connections, app settings) are ``dataclass``es
  with snake_case fields, because only Python code ever touches them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, NotRequired, TypedDict

EmailProvider = Literal["gmail", "zoho", "yahoo", "outlook", "imap"]
McpTransportType = Literal["stdio", "sse", "http"]
ProviderOperation = Literal["listEmails", "getEmail", "searchEmails", "createDraft"]

EMAIL_CATEGORIES: tuple[str, ...] = (
    "urgent",
    "follow-up",
    "promotional",
    "hr-employee",
    "financial",
    "informational",
    "personal",
    "spam",
    "uncategorized",
)
PRIORITY_LEVELS: tuple[str, ...] = ("critical", "high", "medium", "low", "none")
SENTIMENTS: tuple[str, ...] = ("positive", "neutral", "negative", "mixed")
ACTION_TYPES: tuple[str, ...] = (
    "reply",
    "reply-all",
    "forward",
    "archive",
    "delete",
    "label",
    "schedule-meeting",
    "set-reminder",
    "delegate",
    "follow-up-later",
)


# ---------------------------------------------------------------- wire data


class EmailContact(TypedDict):
    name: str
    email: str


class EmailAttachment(TypedDict):
    id: str
    filename: str
    mimeType: str
    size: int


class SuggestedAction(TypedDict):
    type: str
    description: str
    priority: str
    reasoning: str
    draftContent: NotRequired[str]


class ExtractedTask(TypedDict):
    description: str
    priority: str
    source: str
    deadline: NotRequired[str | None]
    assignee: NotRequired[str | None]


class EmailAIEnrichment(TypedDict):
    summary: str
    category: str
    urgencyScore: float
    priority: str
    suggestedActions: list[SuggestedAction]
    extractedTasks: list[ExtractedTask]
    sentiment: str
    keyTopics: list[str]
    requiresResponse: bool
    enrichedAt: str
    deadlineDetected: NotRequired[str]


# ``from`` is a Python keyword, so these two use TypedDict's functional form,
# which accepts any string key. Code reads the sender as ``email["from"]``.
NormalizedEmail = TypedDict(
    "NormalizedEmail",
    {
        "id": str,
        "globalId": str,  # "accountId:messageId" — unique across every account
        "provider": str,
        "accountId": str,
        "accountEmail": str,
        "from": EmailContact,
        "to": list[EmailContact],
        "cc": list[EmailContact],
        "bcc": list[EmailContact],
        "subject": str,
        "date": str,
        "receivedAt": str,
        "snippet": str,
        "body": str,
        "isRead": bool,
        "isStarred": bool,
        "isDraft": bool,
        "labels": list[str],
        "folder": str,
        "hasAttachments": bool,
        "attachments": list[EmailAttachment],
        "replyTo": NotRequired[EmailContact],
        "bodyHtml": NotRequired[str],
        "threadId": NotRequired[str],
        "inReplyTo": NotRequired[str],
        "references": NotRequired[list[str]],
        "aiEnrichment": NotRequired[EmailAIEnrichment],
    },
)


class AccountSummary(TypedDict):
    accountId: str
    accountEmail: str
    provider: str
    totalEmails: int
    unreadCount: int
    isConnected: bool
    lastSyncedAt: NotRequired[str]


EmailHighlight = TypedDict(
    "EmailHighlight",
    {
        "globalId": str,
        "accountEmail": str,
        "subject": str,
        "from": str,  # display name, else address
        "date": str,
        "category": str,
        "urgencyScore": float,
        "oneLiner": str,
    },
)


class EmailQueryOptions(TypedDict, total=False):
    folder: str
    maxResults: int
    unreadOnly: bool
    since: str  # ISO timestamp
    query: str


class EmailDraft(TypedDict, total=False):
    to: list[str]
    cc: list[str]
    bcc: list[str]
    subject: str
    body: str
    inReplyTo: str
    threadId: str


class DraftResult(TypedDict):
    draftId: str
    accountId: str
    provider: str


# ---------------------------------------------------------------- internal config


@dataclass
class McpConnectionConfig:
    transport: McpTransportType
    command: str | None = None
    args: list[str] = field(default_factory=list)
    env: dict[str, str] | None = None
    url: str | None = None
    headers: dict[str, str] | None = None
    tool_map: dict[str, str] | None = None  # ProviderOperation -> downstream tool name
    account_id: str | None = None  # provider-side mailbox id (Zoho)


@dataclass
class EmailAccount:
    id: str
    provider: str
    email: str
    display_name: str
    is_active: bool = True
    mcp_server_name: str = ""
    connection: McpConnectionConfig | None = None


@dataclass
class ScheduleConfig:
    enabled: bool
    times: list[str]
    timezone: str
    max_times_per_day: int = 3


@dataclass
class LLMConfig:
    provider: str
    model: str
    api_key: str
    base_url: str | None
    max_tokens: int
    temperature: float


@dataclass
class NotificationConfig:
    enabled: bool
    sound: bool
    urgent_only: bool


@dataclass
class CacheConfig:
    enabled: bool
    ttl_seconds: int
    max_entries: int


@dataclass
class AppConfig:
    llm: LLMConfig
    accounts: list[EmailAccount]
    schedule: ScheduleConfig
    notifications: NotificationConfig
    cache: CacheConfig
    log_level: str = "info"

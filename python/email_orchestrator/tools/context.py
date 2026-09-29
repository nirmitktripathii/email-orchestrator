"""Shared types and argument helpers for the orchestrator's MCP tools.

A *tool* is a named, described, schema-checked function the AI assistant can
call — like a labelled button on a remote control. Each tool here is a
``ToolDefinition``; the server lists them and dispatches calls, handing each
handler a ``ToolContext`` holding the engines it may need.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Protocol

from ..utils.errors import ValidationError

if TYPE_CHECKING:
    from ..ai.action_recommender import ActionRecommender
    from ..ai.categorizer import EmailCategorizer
    from ..ai.enrichment import EmailEnrichmentService
    from ..ai.summarizer import EmailSummarizer
    from ..core.types import AppConfig
    from ..providers.manager import ProviderManager


class RuntimeScheduler(Protocol):
    def set_schedule(self, times: list[str], enabled: bool) -> None: ...
    def get_schedule(self) -> dict[str, Any]: ...
    async def trigger_now(self) -> None: ...


@dataclass
class ToolContext:
    config: "AppConfig"
    providers: "ProviderManager"
    enrichment: "EmailEnrichmentService"
    summarizer: "EmailSummarizer"
    categorizer: "EmailCategorizer"
    action_recommender: "ActionRecommender"
    scheduler: RuntimeScheduler | None = None  # attached after the scheduler is built


@dataclass
class ToolOutput:
    text: str  # human-readable, shown in chat
    data: Any = None  # structured, for programmatic use


@dataclass
class ToolDefinition:
    name: str
    description: str
    input_schema: dict[str, Any]
    handler: Callable[[dict[str, Any], ToolContext], Awaitable[ToolOutput]] = field(repr=False)


# ---------------------------------------------------------------- argument helpers
# The assistant sometimes sends "25" instead of 25, or "true" instead of true.
# These helpers accept both, like a forgiving form that still validates.


def require_string(args: dict[str, Any], key: str) -> str:
    v = args.get(key)
    if not isinstance(v, str) or not v:
        raise ValidationError(f'Missing or invalid required string argument: "{key}"')
    return v


def optional_string(args: dict[str, Any], key: str) -> str | None:
    v = args.get(key)
    return v if isinstance(v, str) and v else None


def optional_number(args: dict[str, Any], key: str, fallback: float) -> float:
    v = args.get(key)
    if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
        return v
    if isinstance(v, str) and v.strip():
        try:
            n = float(v)
            if math.isfinite(n):
                return int(n) if n.is_integer() else n
        except ValueError:
            pass
    return fallback


def optional_int(args: dict[str, Any], key: str, fallback: int) -> int:
    return int(optional_number(args, key, fallback))


def optional_bool(args: dict[str, Any], key: str, fallback: bool = False) -> bool:
    v = args.get(key)
    if isinstance(v, bool):
        return v
    if v == "true":
        return True
    if v == "false":
        return False
    return fallback


def optional_string_array(args: dict[str, Any], key: str) -> list[str] | None:
    v = args.get(key)
    if isinstance(v, list):
        return [str(s) for s in v if str(s)]
    if isinstance(v, str) and v:
        return [s.strip() for s in v.split(",") if s.strip()]
    return None

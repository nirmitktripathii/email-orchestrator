"""Tool registry: every MCP tool the orchestrator exposes, in presentation order."""

from __future__ import annotations

from .batch import BATCH_TOOLS
from .context import ToolContext, ToolDefinition, ToolOutput
from .email import EMAIL_TOOLS
from .inbox import INBOX_TOOLS
from .schedule import SCHEDULE_TOOLS
from .status import STATUS_TOOLS

ALL_TOOLS: list[ToolDefinition] = [*INBOX_TOOLS, *EMAIL_TOOLS, *BATCH_TOOLS, *STATUS_TOOLS, *SCHEDULE_TOOLS]
TOOLS_BY_NAME: dict[str, ToolDefinition] = {t.name: t for t in ALL_TOOLS}

__all__ = ["ALL_TOOLS", "TOOLS_BY_NAME", "ToolContext", "ToolDefinition", "ToolOutput"]

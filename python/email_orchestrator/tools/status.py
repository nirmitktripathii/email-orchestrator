"""account_status: which accounts are connected, and (optionally) a live unread count."""

from __future__ import annotations

import asyncio
from typing import Any

from ..utils.errors import get_error_message
from .context import ToolContext, ToolDefinition, ToolOutput, optional_bool
from .summary_builder import format_account_status_text


async def _account_status(args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
    statuses = ctx.providers.get_statuses()

    if optional_bool(args, "refresh", False):

        async def live(adapter) -> dict[str, Any]:
            base = adapter.get_status()
            try:
                # Actively (re)connect so the count is a real fetch — and so asking for
                # status is what heals a child process that died since boot.
                await adapter.ensure_connected()
                unread = await adapter.list_emails({"unreadOnly": True, "maxResults": 100})
                return {**base, "isConnected": True, "unreadCount": len(unread), "totalEmails": len(unread)}
            except Exception as e:
                return {**base, "isConnected": adapter.is_connected(), "lastSyncedAt": f"error: {get_error_message(e)}"}

        statuses = list(await asyncio.gather(*(live(a) for a in ctx.providers.get_adapters())))

    connected = sum(1 for s in statuses if s.get("isConnected"))
    text = f"{format_account_status_text(statuses)}\n\n{connected}/{len(statuses)} account(s) connected."
    return ToolOutput(text, statuses)


STATUS_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        "account_status",
        "Show the connection status of every configured email account (connected/disconnected, provider, last sync). "
        "Set refresh=true to also fetch a live unread count per account.",
        {
            "type": "object",
            "properties": {
                "refresh": {
                    "type": "boolean",
                    "description": "Fetch a live unread count per account (slower). Default false.",
                }
            },
        },
        _account_status,
    )
]

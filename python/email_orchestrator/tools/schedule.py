"""configure_schedule / trigger_digest_now.

configure_schedule changes the RUNNING schedule only. To survive a restart the
user sets DIGEST_SCHEDULE in .env — the orchestrator never silently rewrites
persistent config.
"""

from __future__ import annotations

import re
from typing import Any

from .context import ToolContext, ToolDefinition, ToolOutput, optional_bool, optional_string_array

TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _describe(s: dict[str, Any]) -> str:
    return f"{'enabled' if s['enabled'] else 'disabled'} at [{', '.join(s['times']) or '—'}] ({s['timezone']})"


async def _configure_schedule(args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
    if ctx.scheduler is None:
        return ToolOutput(
            "⚠️ Scheduler is not running in this session, so the schedule cannot be changed here.", {"available": False}
        )
    times = optional_string_array(args, "times")
    has_enabled = isinstance(args.get("enabled"), bool)

    if times is None and not has_enabled:  # pure view
        current = ctx.scheduler.get_schedule()
        return ToolOutput(f"Current schedule: {_describe(current)}.", current)

    if times is not None:
        if len(times) > 3:
            return ToolOutput("❌ At most 3 digest times per day are allowed.", {"error": "too_many_times"})
        bad = [t for t in times if not TIME_RE.match(t)]
        if bad:
            return ToolOutput(f'❌ Invalid time(s): {", ".join(bad)}. Use 24h "HH:MM".', {"error": "invalid_time", "bad": bad})

    current = ctx.scheduler.get_schedule()
    enabled = optional_bool(args, "enabled", current["enabled"])
    ctx.scheduler.set_schedule(times if times is not None else list(current["times"]), enabled)

    updated = ctx.scheduler.get_schedule()
    text = (
        f"✅ Schedule updated: {_describe(updated)}.\n"
        f"To persist across restarts, set DIGEST_SCHEDULE={','.join(updated['times'])} in your .env."
    )
    return ToolOutput(text, updated)


async def _trigger_digest_now(_args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
    if ctx.scheduler is None:
        return ToolOutput("⚠️ Scheduler is not running in this session.", {"available": False})
    await ctx.scheduler.trigger_now()
    return ToolOutput("✅ Digest generated and pushed.", {"triggered": True})


SCHEDULE_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        "configure_schedule",
        'View or change the scheduled daily digest times (up to 3 per day, 24h "HH:MM"). '
        "Call with no arguments to view the current schedule. Changes take effect immediately for this "
        "session; to persist across restarts, set DIGEST_SCHEDULE in .env.",
        {
            "type": "object",
            "properties": {
                "times": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": 'Up to 3 times in 24h "HH:MM" format, e.g. ["09:00","14:00","19:00"].',
                },
                "enabled": {"type": "boolean", "description": "Enable or disable scheduled digests."},
            },
        },
        _configure_schedule,
    ),
    ToolDefinition(
        "trigger_digest_now",
        "Immediately generate and push a daily digest notification now (does not change the schedule).",
        {"type": "object", "properties": {}},
        _trigger_digest_now,
    ),
]

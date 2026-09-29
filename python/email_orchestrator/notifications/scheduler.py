"""Scheduled digests (up to 3×/day) plus an optional urgent-mail monitor.

Analogy: an alarm clock with up to three alarms. Once a minute it glances at
the wall clock *in your timezone*; if the time matches an alarm it hasn't rung
yet today, it rings (builds a digest and pops a notification).

The TypeScript version used node-cron; this is the same behaviour with a
plain asyncio loop, so there is no extra dependency.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo

from ..core.types import ScheduleConfig
from ..utils.errors import get_error_message
from ..utils.logger import logger
from .notifier import DesktopNotifier

_log = logger.child("scheduler")
_TIME = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


@dataclass
class DigestNotification:
    title: str
    message: str
    urgent_items: list[dict[str, Any]] = field(default_factory=list)


def normalize_time(t: str) -> str | None:
    """``"9:05"`` → ``"09:05"``; invalid → None."""
    m = _TIME.match(t)
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else None


class DigestScheduler:
    def __init__(
        self,
        schedule: ScheduleConfig,
        notifier: DesktopNotifier,
        produce_digest: Callable[[], Awaitable[DigestNotification]],
        produce_urgent: Callable[[], Awaitable[list[dict[str, Any]]]] | None = None,
        urgent_poll_minutes: float = 0,
        *,
        clock: Callable[[ZoneInfo], datetime] | None = None,
    ) -> None:
        self.timezone = schedule.timezone
        self._tz = ZoneInfo(schedule.timezone)
        self.times = list(schedule.times)
        self.enabled = schedule.enabled
        self.notifier = notifier
        self.produce_digest = produce_digest
        self.produce_urgent = produce_urgent
        self.urgent_poll_minutes = urgent_poll_minutes
        self._clock = clock or (lambda tz: datetime.now(tz))
        self._fired: set[str] = set()  # "YYYY-MM-DD HH:MM" already run
        self._notified_urgent: set[str] = set()
        self._tasks: list[asyncio.Task[None]] = []

    # ---- lifecycle

    def start(self) -> None:
        self._log_schedule()
        self._tasks.append(asyncio.create_task(self._digest_loop()))
        if self.urgent_poll_minutes > 0 and self.produce_urgent:
            _log.info(f"Starting urgent monitor (every {self.urgent_poll_minutes} min)")
            self._tasks.append(asyncio.create_task(self._urgent_loop()))

    def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        self._tasks.clear()
        _log.info("Scheduler stopped")

    # ---- RuntimeScheduler surface (driven by the schedule tools)

    def get_schedule(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "times": list(self.times), "timezone": self.timezone}

    def set_schedule(self, times: list[str], enabled: bool) -> None:
        self.times = list(times)
        self.enabled = enabled
        self._log_schedule()
        _log.info("Schedule reconfigured", {"enabled": enabled, "times": self.times})

    async def trigger_now(self) -> None:
        await self._run_digest("manual")

    # ---- internals

    def _log_schedule(self) -> None:
        if not self.enabled or not self.times:
            _log.info("Digest schedule disabled or empty")
            return
        for t in self.times:
            if normalize_time(t) is None:
                _log.warn(f'Skipping invalid schedule time "{t}"')
            else:
                _log.info(f"Scheduled digest at {t} ({self.timezone})")

    def due_times(self, now: datetime) -> list[str]:
        """Times that should fire at ``now`` and haven't yet today (pure; unit-tested)."""
        if not self.enabled:
            return []
        hhmm = now.strftime("%H:%M")
        out = []
        for t in self.times:
            if normalize_time(t) == hhmm:
                key = f"{now.date().isoformat()} {hhmm}"
                if key not in self._fired:
                    self._fired.add(key)
                    out.append(t)
        if len(self._fired) > 100:  # bound memory; old days are irrelevant
            today = now.date().isoformat()
            self._fired = {k for k in self._fired if k.startswith(today)}
        return out

    async def _digest_loop(self) -> None:
        while True:
            now = self._clock(self._tz)
            for t in self.due_times(now):
                asyncio.create_task(self._run_digest(t))
            await asyncio.sleep(60 - now.second - now.microsecond / 1e6 + 0.05)  # wake just after the next minute

    async def _run_digest(self, label: str) -> None:
        _log.info(f"Running digest ({label})")
        try:
            digest = await self.produce_digest()
            await self.notifier.notify_digest(digest.title, digest.message)
            _log.info("Digest pushed", {"urgentCount": len(digest.urgent_items)})
        except Exception as e:
            _log.error("Digest run failed", e, {"label": label})

    async def _urgent_loop(self) -> None:
        while True:
            await asyncio.sleep(self.urgent_poll_minutes * 60)
            await self.check_urgent()

    async def check_urgent(self) -> None:
        if not self.produce_urgent:
            return
        try:
            for item in await self.produce_urgent():
                if item["globalId"] in self._notified_urgent:
                    continue
                self._notified_urgent.add(item["globalId"])
                await self.notifier.notify_urgent(item)
            if len(self._notified_urgent) > 5000:
                self._notified_urgent.clear()
        except Exception as e:
            _log.warn("Urgent monitor check failed", {"error": get_error_message(e)})

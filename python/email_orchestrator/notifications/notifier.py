"""Desktop notifications — best effort.

Uses ``plyer`` when installed (``pip install email-orchestrator[notify]``);
otherwise the notification is only logged. A notification failure is never
allowed to break a digest run.
"""

from __future__ import annotations

import asyncio
from typing import Any

from ..core.types import NotificationConfig
from ..utils.errors import get_error_message
from ..utils.logger import logger

_log = logger.child("notifier")


def truncate(text: str, max_len: int) -> str:
    if not text:
        return ""
    return text if len(text) <= max_len else f"{text[: max_len - 1]}…"


class DesktopNotifier:
    def __init__(self, config: NotificationConfig) -> None:
        self.config = config
        try:
            from plyer import notification  # type: ignore[import-not-found]

            self._backend: Any = notification
        except Exception:
            self._backend = None

    @property
    def enabled(self) -> bool:
        return self.config.enabled

    async def notify(self, title: str, message: str, sound: bool | None = None) -> None:
        if not self.config.enabled:
            _log.debug("Notifications disabled; skipping", {"title": title})
            return
        if self._backend is None:
            _log.info("Notification (no desktop backend installed)", {"title": title, "message": message})
            return
        try:
            # plyer is blocking; keep it off the event loop.
            await asyncio.to_thread(
                self._backend.notify, title=title, message=message, app_name="email-orchestrator", timeout=10
            )
        except Exception as e:
            _log.warn("Notification failed to display", {"error": get_error_message(e)})

    async def notify_urgent(self, email: dict[str, Any]) -> None:
        await self.notify(
            f"🔴 Urgent ({email['urgencyScore']}/10): {truncate(email['subject'], 60)}",
            f"{email['from']} · {email['accountEmail']}\n{truncate(email['oneLiner'], 120)}",
            sound=True,
        )

    async def notify_digest(self, title: str, message: str) -> None:
        await self.notify(title, truncate(message, 240))

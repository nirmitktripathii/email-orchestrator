"""Structured JSON logger that writes to **stderr only**.

An MCP server speaks JSON-RPC over stdout; a single stray ``print()`` to stdout
would corrupt the protocol stream. So every log line goes to stderr.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from datetime import datetime, timezone
from typing import Any

LOG_LEVELS = {"debug": 0, "info": 1, "warn": 2, "error": 3}

# One shared, mutable level so ``logger.set_level`` also affects existing children.
_state = {"level": os.environ.get("LOG_LEVEL", "info") if os.environ.get("LOG_LEVEL") in LOG_LEVELS else "info"}


class Logger:
    def __init__(self, context: str | None = None) -> None:
        self.context = context

    def set_level(self, level: str) -> None:
        if level in LOG_LEVELS:
            _state["level"] = level

    def child(self, context: str) -> "Logger":
        return Logger(f"{self.context}:{context}" if self.context else context)

    def debug(self, message: str, data: dict[str, Any] | None = None) -> None:
        self._log("debug", message, data)

    def info(self, message: str, data: dict[str, Any] | None = None) -> None:
        self._log("info", message, data)

    def warn(self, message: str, data: dict[str, Any] | None = None) -> None:
        self._log("warn", message, data)

    def error(self, message: str, error: BaseException | object | None = None, data: dict[str, Any] | None = None) -> None:
        payload = dict(data or {})
        if isinstance(error, BaseException):
            payload["error"] = {
                "name": type(error).__name__,
                "message": str(error),
                "stack": "".join(traceback.format_exception(error))[-2000:],
            }
        elif error is not None:
            payload["error"] = {"name": "UnknownError", "message": str(error)}
        self._log("error", message, payload)

    def _log(self, level: str, message: str, data: dict[str, Any] | None) -> None:
        if LOG_LEVELS[level] < LOG_LEVELS[_state["level"]]:
            return
        entry: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": level,
            "message": message,
        }
        if self.context:
            entry["context"] = self.context
        if data:
            entry["data"] = data
        try:
            sys.stderr.write(json.dumps(entry, default=str, ensure_ascii=False) + "\n")
            sys.stderr.flush()
        except Exception:  # logging must never crash the server
            pass


logger = Logger()

"""In-memory LRU cache with TTL expiry (used for emails and AI enrichment)."""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Generic, TypeVar

from ..utils.logger import logger

T = TypeVar("T")
_log = logger.child("cache")


class LRUCache(Generic[T]):
    """Least-recently-used cache: when full, the entry untouched the longest is evicted.

    ``OrderedDict`` keeps entries in access order, so eviction is O(1) — the oldest
    entry is always at the front.
    """

    def __init__(self, max_entries: int = 1000, ttl_seconds: float = 300) -> None:
        self._data: OrderedDict[str, tuple[T, float]] = OrderedDict()
        self.max_entries = max_entries
        self.ttl = ttl_seconds
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> T | None:
        entry = self._data.get(key)
        if entry is None:
            self.misses += 1
            return None
        value, expires_at = entry
        if time.monotonic() > expires_at:
            del self._data[key]
            self.misses += 1
            return None
        self._data.move_to_end(key)  # mark as most recently used
        self.hits += 1
        return value

    def set(self, key: str, value: T, ttl_seconds: float | None = None) -> None:
        if key not in self._data and len(self._data) >= self.max_entries:
            evicted, _ = self._data.popitem(last=False)
            _log.debug("Evicted LRU entry", {"key": evicted})
        self._data[key] = (value, time.monotonic() + (self.ttl if ttl_seconds is None else ttl_seconds))
        self._data.move_to_end(key)

    def has(self, key: str) -> bool:
        entry = self._data.get(key)
        if entry is None:
            return False
        if time.monotonic() > entry[1]:
            del self._data[key]
            return False
        return True

    def delete(self, key: str) -> bool:
        return self._data.pop(key, None) is not None

    def clear(self) -> None:
        self._data.clear()
        self.hits = 0
        self.misses = 0

    def prune(self) -> int:
        now = time.monotonic()
        expired = [k for k, (_, exp) in self._data.items() if now > exp]
        for k in expired:
            del self._data[k]
        return len(expired)

    def stats(self) -> dict[str, float]:
        total = self.hits + self.misses
        return {
            "size": len(self._data),
            "maxEntries": self.max_entries,
            "hitRate": self.hits / total if total else 0,
            "hits": self.hits,
            "misses": self.misses,
        }

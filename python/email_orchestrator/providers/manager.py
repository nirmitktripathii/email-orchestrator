"""ProviderManager: one object that fans every request out to all accounts.

Analogy: a head waiter taking one order ("show me my mail") to every kitchen
(account) at once. If one kitchen is on fire, the others still serve — the
failing account is logged and skipped, never allowed to break the whole meal.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, Protocol

from ..core.normalizer import date_ms
from ..core.types import AppConfig, EmailAccount
from ..utils.errors import EmailNotFoundError, get_error_message
from ..utils.logger import logger
from .base import GenericAdapter
from .gmail import GmailAdapter
from .graph import GraphAdapter
from .imap import ImapAdapter
from .zoho import ZohoAdapter

_log = logger.child("provider-manager")


class ProviderAdapter(Protocol):
    """What the manager needs from an adapter (real ones and test fakes alike)."""

    account_id: str
    provider: str
    email: str

    async def connect(self) -> None: ...
    async def disconnect(self) -> None: ...
    async def ensure_connected(self) -> None: ...
    def is_connected(self) -> bool: ...
    async def list_emails(self, options: dict[str, Any] | None = None) -> list[dict[str, Any]]: ...
    async def search_emails(self, query: str, options: dict[str, Any] | None = None) -> list[dict[str, Any]]: ...
    async def get_email(self, email_id: str) -> dict[str, Any] | None: ...
    async def create_draft(self, draft: dict[str, Any]) -> dict[str, str]: ...
    def get_status(self) -> dict[str, Any]: ...


def parse_global_id(global_id: str) -> tuple[str, str] | None:
    """``"gmail-primary:abc:123"`` → ``("gmail-primary", "abc:123")`` (split on the FIRST colon)."""
    idx = global_id.find(":")
    if idx == -1:
        return None
    return global_id[:idx], global_id[idx + 1 :]


def create_adapter(account: EmailAccount) -> ProviderAdapter:
    if account.provider == "gmail":
        return GmailAdapter(account)
    if account.provider == "zoho":
        return ZohoAdapter(account)
    if account.provider in ("yahoo", "imap"):
        return ImapAdapter(account)
    if account.provider == "outlook":
        env = account.connection.env if account.connection else None
        return ImapAdapter(account) if env and env.get("IMAP_HOST") else GraphAdapter(account)
    return GenericAdapter(account)


class ProviderManager:
    def __init__(self, accounts: list[EmailAccount], prebuilt: list[ProviderAdapter] | None = None) -> None:
        self._adapters: dict[str, ProviderAdapter] = {}
        if prebuilt is not None:
            for a in prebuilt:
                self._adapters[a.account_id] = a
            _log.info(f"Provider manager initialized with {len(self._adapters)} pre-built adapter(s)")
            return
        for account in accounts:
            if not account.is_active:
                _log.info(f"Skipping inactive account {account.id}")
                continue
            if account.connection is None:
                _log.warn(f"Account {account.id} has no MCP connection — skipping (configure it to enable)")
                continue
            try:
                self._adapters[account.id] = create_adapter(account)
            except Exception as e:
                _log.error(f"Failed to construct adapter for {account.id}", e)
        _log.info(f"Provider manager initialized with {len(self._adapters)} adapter(s)")

    @classmethod
    def from_config(cls, config: AppConfig) -> "ProviderManager":
        return cls(config.accounts)

    @classmethod
    def with_adapters(cls, adapters: list[ProviderAdapter]) -> "ProviderManager":
        return cls([], adapters)

    # ---- lifecycle

    async def connect_all(self) -> list[dict[str, Any]]:
        adapters = list(self._adapters.values())
        results = await asyncio.gather(*(a.connect() for a in adapters), return_exceptions=True)
        out = []
        for adapter, r in zip(adapters, results):
            if isinstance(r, BaseException):
                _log.warn(f"Adapter {adapter.account_id} failed to connect", {"error": get_error_message(r)})
                out.append({"accountId": adapter.account_id, "connected": False, "error": get_error_message(r)})
            else:
                out.append({"accountId": adapter.account_id, "connected": True})
        return out

    async def disconnect_all(self) -> None:
        await asyncio.gather(*(a.disconnect() for a in self._adapters.values()), return_exceptions=True)
        _log.info("All adapters disconnected")

    # ---- lookup

    def get_adapter(self, account_id: str) -> ProviderAdapter | None:
        return self._adapters.get(account_id)

    def get_adapters(self) -> list[ProviderAdapter]:
        return list(self._adapters.values())

    def get_connected_adapters(self) -> list[ProviderAdapter]:
        return [a for a in self._adapters.values() if a.is_connected()]

    def has_accounts(self) -> bool:
        return bool(self._adapters)

    # ---- cross-account operations

    async def list_all_emails(self, options: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        return await self._fan_out(lambda a: a.list_emails(dict(options or {})), "listAllEmails")

    async def search_all(self, query: str, options: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        return await self._fan_out(lambda a: a.search_emails(query, dict(options or {})), "searchAll")

    async def get_email_by_global_id(self, global_id: str) -> dict[str, Any]:
        parts = parse_global_id(global_id)
        if not parts:
            raise EmailNotFoundError(global_id)
        account_id, message_id = parts
        adapter = self._adapters.get(account_id)
        if not adapter:
            raise EmailNotFoundError(message_id, account_id)
        email = await adapter.get_email(message_id)
        if not email:
            raise EmailNotFoundError(message_id, account_id)
        return email

    async def create_draft(self, account_id: str, draft: dict[str, Any]) -> dict[str, str]:
        adapter = self._adapters.get(account_id)
        if not adapter:
            raise EmailNotFoundError(f"account:{account_id}", account_id)
        return await adapter.create_draft(draft)

    def get_statuses(self) -> list[dict[str, Any]]:
        return [a.get_status() for a in self._adapters.values()]

    async def _fan_out(
        self, op: Callable[[ProviderAdapter], Awaitable[list[dict[str, Any]]]], label: str
    ) -> list[dict[str, Any]]:
        adapters = self.get_adapters()
        if not adapters:
            _log.warn(f"{label}: no adapters configured")
            return []

        async def one(adapter: ProviderAdapter) -> list[dict[str, Any]]:
            await adapter.ensure_connected()
            return await op(adapter)

        results = await asyncio.gather(*(one(a) for a in adapters), return_exceptions=True)
        merged: list[dict[str, Any]] = []
        for adapter, r in zip(adapters, results):
            if isinstance(r, BaseException):
                _log.warn(f"{label}: account {adapter.account_id} failed", {"error": get_error_message(r)})
            else:
                merged.extend(r)
        merged.sort(key=lambda e: date_ms(e.get("date")) or 0, reverse=True)  # newest first
        return merged

"""Custom error types. Every error extends ``AppError`` for consistent handling."""

from __future__ import annotations

from typing import Any


class AppError(Exception):
    """Base application error with an error code and optional context."""

    def __init__(
        self,
        message: str,
        code: str,
        status_code: int = 500,
        is_operational: bool = True,
        context: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = status_code
        self.is_operational = is_operational
        self.context = context


class LLMError(AppError):
    def __init__(self, message: str, context: dict[str, Any] | None = None) -> None:
        super().__init__(message, "LLM_ERROR", 502, True, context)


class LLMRateLimitError(LLMError):
    def __init__(self, message: str, retry_after_ms: int | None = None) -> None:
        super().__init__(message, {"retryAfterMs": retry_after_ms})
        self.retry_after_ms = retry_after_ms


class ProviderConnectionError(AppError):
    def __init__(self, provider: str, message: str, context: dict[str, Any] | None = None) -> None:
        super().__init__(message, "PROVIDER_CONNECTION_ERROR", 503, True, {"provider": provider, **(context or {})})
        self.provider = provider


class ProviderAuthError(AppError):
    def __init__(self, provider: str, message: str) -> None:
        super().__init__(message, "PROVIDER_AUTH_ERROR", 401, True, {"provider": provider})
        self.provider = provider


class EmailNotFoundError(AppError):
    def __init__(self, email_id: str, account_id: str | None = None) -> None:
        suffix = f" in account {account_id}" if account_id else ""
        super().__init__(
            f"Email not found: {email_id}{suffix}",
            "EMAIL_NOT_FOUND",
            404,
            True,
            {"emailId": email_id, "accountId": account_id},
        )


class ConfigError(AppError):
    def __init__(self, message: str, context: dict[str, Any] | None = None) -> None:
        super().__init__(message, "CONFIG_ERROR", 500, True, context)


class ValidationError(AppError):
    def __init__(self, message: str, context: dict[str, Any] | None = None) -> None:
        super().__init__(message, "VALIDATION_ERROR", 400, True, context)


class ToolExecutionError(AppError):
    def __init__(self, tool_name: str, message: str, context: dict[str, Any] | None = None) -> None:
        super().__init__(message, "TOOL_EXECUTION_ERROR", 500, True, {"toolName": tool_name, **(context or {})})
        self.tool_name = tool_name


def get_error_message(error: BaseException | object) -> str:
    """Safely extract a human-readable message from any error value."""
    if isinstance(error, BaseException):
        text = str(error)
        # Some transport errors (e.g. anyio.ClosedResourceError) carry no message.
        return text if text else type(error).__name__
    if isinstance(error, str):
        return error
    return "An unknown error occurred"

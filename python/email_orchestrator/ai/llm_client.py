"""LLM-agnostic client: Google Gemini (primary) or any OpenAI-compatible endpoint.

First principles: an LLM is a remote function ``text in → text out`` that is
(1) slow, (2) rate-limited, and (3) not guaranteed to follow instructions.
This module turns it into something dependable:

* rate limits  → retry with exponential backoff, honouring the server's hint;
* "thinking" models that burn their token budget on hidden reasoning before
  writing any JSON → retry with DOUBLE the budget;
* sloppy output (``​```json`` fences, trailing commas, prose around the object)
  → a tolerant JSON extractor.
"""

from __future__ import annotations

import asyncio
import json
import math
import random
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, TypeVar

import httpx

from ..core.types import LLMConfig
from ..utils.errors import LLMError, LLMRateLimitError
from ..utils.logger import logger

_log = logger.child("llm-client")
T = TypeVar("T")

# Thinking models spend hidden reasoning tokens BEFORE the body, so the JSON
# budget needs a floor well above the visible JSON size.
JSON_TOKEN_FLOOR = 2048
JSON_TOKEN_CEILING = 8192


@dataclass(frozen=True)
class ChatMessage:
    role: Literal["system", "user", "assistant"]
    content: str


@dataclass
class LLMResponse:
    content: str
    model: str
    finish_reason: str
    latency_ms: int
    usage: dict[str, int] = field(default_factory=lambda: {"promptTokens": 0, "completionTokens": 0, "totalTokens": 0})


class LLMClient:
    """The real client. ``FakeLLM`` in the tests implements the same two methods."""

    def __init__(self, config: LLMConfig) -> None:
        self.config = config
        self._total_tokens = 0
        self._request_count = 0
        self._gemini = None
        if config.provider == "gemini" and config.api_key:
            from google import genai  # imported lazily so tests never need the SDK

            self._gemini = genai.Client(api_key=config.api_key)
            _log.info("Gemini client initialized", {"model": config.model})
        _log.info(
            "LLM client initialized",
            {"provider": config.provider, "model": config.model, "hasApiKey": bool(config.api_key)},
        )

    async def complete(
        self,
        messages: list[ChatMessage],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
        json_mode: bool = False,
    ) -> LLMResponse:
        self._request_count += 1
        try:
            if self.config.provider == "gemini":
                resp = await self._complete_gemini(messages, temperature, max_tokens, json_mode)
            else:
                resp = await self._complete_openai_compat(messages, temperature, max_tokens, json_mode)
        except Exception as e:
            _log.error("LLM completion failed", e)
            raise
        self._total_tokens += resp.usage.get("totalTokens", 0)
        _log.debug(
            "LLM completion successful",
            {"model": resp.model, "tokens": resp.usage.get("totalTokens", 0), "latencyMs": resp.latency_ms},
        )
        return resp

    async def complete_json(
        self,
        messages: list[ChatMessage],
        *,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> Any:
        """Complete and parse JSON; on an empty/truncated/unparseable reply retry with double the budget."""
        max_attempts = 3
        budget = max(max_tokens or self.config.max_tokens or 0, JSON_TOKEN_FLOOR)
        last_preview, last_finish = "", "unknown"

        for attempt in range(1, max_attempts + 1):
            resp = await self.complete(messages, temperature=temperature, max_tokens=budget, json_mode=True)
            text = (resp.content or "").strip()
            last_preview, last_finish = text[:200], resp.finish_reason

            starved = not text or resp.finish_reason == "MAX_TOKENS"
            if not starved:
                parsed = extract_json(text)
                if parsed is not _NOTHING:
                    return parsed

            if attempt < max_attempts:
                next_budget = min(budget * 2, JSON_TOKEN_CEILING)
                _log.warn(
                    "LLM JSON response unusable — retrying with a larger token budget",
                    {
                        "attempt": attempt,
                        "finishReason": resp.finish_reason,
                        "textLen": len(text),
                        "reason": "empty-or-max-tokens" if starved else "parse-failed",
                        "nextBudget": next_budget,
                    },
                )
                budget = next_budget

        raise LLMError(
            f"LLM did not return valid JSON after {max_attempts} attempts "
            f'(last finishReason={last_finish}, preview="{last_preview[:120]}")'
        )

    def get_stats(self) -> dict[str, Any]:
        return {
            "totalTokensUsed": self._total_tokens,
            "requestCount": self._request_count,
            "provider": self.config.provider,
            "model": self.config.model,
        }

    # ---- providers

    async def _complete_gemini(self, messages, temperature, max_tokens, json_mode) -> LLMResponse:
        if self._gemini is None:
            raise LLMError("Gemini client not initialized — check LLM_API_KEY")
        from google.genai import types as gtypes

        start = time.monotonic()
        system = next((m for m in messages if m.role == "system"), None)
        contents = [
            gtypes.Content(role="model" if m.role == "assistant" else "user", parts=[gtypes.Part(text=m.content)])
            for m in messages
            if m.role != "system"
        ]
        cfg = gtypes.GenerateContentConfig(
            temperature=temperature if temperature is not None else self.config.temperature,
            max_output_tokens=max_tokens or self.config.max_tokens,
            system_instruction=system.content if system else None,
            response_mime_type="application/json" if json_mode else None,
        )
        result = await retry_with_backoff(
            lambda: self._gemini.aio.models.generate_content(model=self.config.model, contents=contents, config=cfg)
        )
        try:
            text = result.text or ""
        except Exception:  # SDK raises when a candidate has no text parts
            text = ""
        usage = result.usage_metadata
        finish = "unknown"
        if result.candidates and result.candidates[0].finish_reason is not None:
            fr = result.candidates[0].finish_reason
            finish = getattr(fr, "name", None) or str(fr)
        return LLMResponse(
            content=text,
            model=self.config.model,
            finish_reason=finish,
            latency_ms=int((time.monotonic() - start) * 1000),
            usage={
                "promptTokens": (usage.prompt_token_count or 0) if usage else 0,
                "completionTokens": (usage.candidates_token_count or 0) if usage else 0,
                "totalTokens": (usage.total_token_count or 0) if usage else 0,
            },
        )

    async def _complete_openai_compat(self, messages, temperature, max_tokens, json_mode) -> LLMResponse:
        start = time.monotonic()
        base_url = self.config.base_url or default_base_url(self.config.provider)
        body: dict[str, Any] = {
            "model": self.config.model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "temperature": temperature if temperature is not None else self.config.temperature,
            "max_tokens": max_tokens or self.config.max_tokens,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}

        async def call() -> dict[str, Any]:
            async with httpx.AsyncClient(timeout=120) as client:
                r = await client.post(
                    f"{base_url}/chat/completions",
                    json=body,
                    headers={"Authorization": f"Bearer {self.config.api_key or ''}"},
                )
            if r.status_code >= 400:
                if r.status_code == 429:
                    ra = r.headers.get("retry-after")
                    raise LLMRateLimitError(
                        f"Rate limited by {self.config.provider}: {r.text}",
                        int(ra) * 1000 if ra and ra.isdigit() else None,
                    )
                raise LLMError(f"{self.config.provider} API error ({r.status_code}): {r.text}")
            return r.json()

        result = await retry_with_backoff(call)
        choice = (result.get("choices") or [{}])[0]
        usage = result.get("usage") or {}
        return LLMResponse(
            content=str((choice.get("message") or {}).get("content") or ""),
            model=str(result.get("model") or self.config.model),
            finish_reason=str(choice.get("finish_reason") or "unknown"),
            latency_ms=int((time.monotonic() - start) * 1000),
            usage={
                "promptTokens": usage.get("prompt_tokens", 0),
                "completionTokens": usage.get("completion_tokens", 0),
                "totalTokens": usage.get("total_tokens", 0),
            },
        )


def default_base_url(provider: str) -> str:
    return {
        "openai": "https://api.openai.com/v1",
        "anthropic": "https://api.anthropic.com/v1",
        "groq": "https://api.groq.com/openai/v1",
        "ollama": "http://localhost:11434/v1",
        "custom": "http://localhost:8000/v1",
    }.get(provider, "https://api.openai.com/v1")


# ---------------------------------------------------------------- retry / backoff

_TRANSIENT_CODE = re.compile(r"\b(429|500|502|503|504)\b")
_TRANSIENT_WORD = re.compile(r"RESOURCE_EXHAUSTED|UNAVAILABLE|rate.?limit|quota|overloaded|temporarily", re.I)
_RETRY_DELAY = re.compile(r'"?retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s"?', re.I)


def classify_transient(error: BaseException) -> tuple[bool, int | None]:
    """Is this a retry-worthy rate-limit/availability error? Returns ``(retryable, retry_after_ms)``."""
    if isinstance(error, LLMRateLimitError):
        return True, error.retry_after_ms
    msg = str(error)
    if not (_TRANSIENT_CODE.search(msg) or _TRANSIENT_WORD.search(msg)):
        return False, None
    m = _RETRY_DELAY.search(msg)
    return True, (math.ceil(float(m.group(1)) * 1000) if m else None)


async def retry_with_backoff(fn: Callable[[], Awaitable[T]], max_retries: int = 5) -> T:
    last: BaseException | None = None
    for attempt in range(max_retries + 1):
        try:
            return await fn()
        except Exception as e:
            last = e
            if attempt == max_retries:
                break
            retryable, retry_after_ms = classify_transient(e)
            if not retryable:
                raise
            # Honour a server-suggested delay; else exponential backoff + jitter, capped at 30s.
            delay_ms = (
                retry_after_ms + random.random() * 500
                if retry_after_ms
                else min(1000 * 2**attempt + random.random() * 500, 30000)
            )
            _log.warn(
                f"LLM rate-limited/transient error — backing off {round(delay_ms)}ms",
                {"attempt": attempt + 1, "maxRetries": max_retries, "error": str(e)[:160]},
            )
            await asyncio.sleep(delay_ms / 1000)
    raise last if last else LLMError("All retry attempts failed")


# ---------------------------------------------------------------- tolerant JSON extraction

_NOTHING = object()
_FENCE = re.compile(r"```(?:json)?\s*([\s\S]*?)\s*```", re.I)
_TRAILING_COMMA = re.compile(r",\s*([}\]])")


def extract_json(raw: str) -> Any:
    """Recover a JSON value from an LLM reply, or return the ``_NOTHING`` sentinel."""
    s = raw.strip()
    fence = _FENCE.search(s)
    if fence:
        s = fence.group(1).strip()
    sliced = slice_balanced(s)
    if sliced:
        s = sliced
    for candidate in (s, _TRAILING_COMMA.sub(r"\1", s)):
        try:
            return json.loads(candidate)
        except ValueError:
            continue
    return _NOTHING


def slice_balanced(s: str) -> str | None:
    """First balanced ``{…}`` or ``[…]`` substring, respecting strings and escapes."""
    m = re.search(r"[{\[]", s)
    if not m:
        return None
    start = m.start()
    open_ch = s[start]
    close_ch = "}" if open_ch == "{" else "]"
    depth, in_str, escaped = 0, False, False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return s[start : i + 1]
    return None  # truncated — caller retries with a bigger budget

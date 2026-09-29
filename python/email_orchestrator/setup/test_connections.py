"""Smoke test: does the LLM answer, and does every account connect and list mail?

    python -m email_orchestrator.setup.test_connections

This is the first thing to run when something is wrong. It prints to stdout
(it is not an MCP server, so stdout is free to use).
"""

from __future__ import annotations

import asyncio
import sys
import time

from ..ai.llm_client import ChatMessage, LLMClient
from ..core.config import load_config, validate_config
from ..providers.manager import ProviderManager
from ..utils.errors import get_error_message


def ok(msg: str) -> None:
    print(f"  ✅ {msg}")


def bad(msg: str) -> None:
    print(f"  ❌ {msg}")


async def test_llm() -> bool:
    print("\n1) Testing LLM…")
    config = load_config()
    if not config.llm.api_key and config.llm.provider not in ("ollama", "custom"):
        bad("LLM_API_KEY is not set in .env.")
        return False
    try:
        llm = LLMClient(config.llm)
        start = time.monotonic()
        res = await llm.complete([ChatMessage("user", "Reply with exactly the word: OK")], max_tokens=512, temperature=0)
        ms = int((time.monotonic() - start) * 1000)
        ok(f'{config.llm.provider}/{config.llm.model} responded in {ms}ms: "{res.content.strip()[:40]}"')
        return True
    except Exception as e:
        bad(f"LLM call failed: {get_error_message(e)}")
        return False


async def test_providers() -> bool:
    print("\n2) Testing email providers…")
    manager = ProviderManager.from_config(load_config())
    if not manager.has_accounts():
        bad("No provider accounts configured in .env.")
        return False
    all_ok = True
    for r in await manager.connect_all():
        if not r["connected"]:
            bad(f"{r['accountId']}: connection failed — {r.get('error') or 'unknown error'}")
            all_ok = False
            continue
        adapter = manager.get_adapter(r["accountId"])
        try:
            emails = await adapter.list_emails({"maxResults": 1})
            ok(f"{r['accountId']} ({adapter.provider}): connected · listed {len(emails)} email(s)")
        except Exception as e:
            bad(f"{r['accountId']} ({adapter.provider}): connected but listing failed — {get_error_message(e)}")
            all_ok = False
    await manager.disconnect_all()
    return all_ok


async def main() -> int:
    print("=== Email AI Agent — Connection Test (Python) ===")
    for issue in validate_config(load_config()):
        print(f"  • note: {issue}")
    llm_ok = await test_llm()
    providers_ok = await test_providers()
    print("\n=== Summary ===")
    print(f"  LLM:       {'OK' if llm_ok else 'FAILED'}")
    print(f"  Providers: {'OK' if providers_ok else 'FAILED (see above)'}\n")
    return 0 if llm_ok else 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # emoji on the Windows console
    sys.exit(asyncio.run(main()))

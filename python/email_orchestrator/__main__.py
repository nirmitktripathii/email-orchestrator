"""Entry point: ``python -m email_orchestrator``.

Boot sequence (same as the TypeScript ``index.ts``):
  1. Load + validate configuration (.env).
  2. Build the LLM client, AI engines and provider manager (``app.build_context``).
  3. Build the scheduler and attach it to the tool context.
  4. Serve MCP over stdio FIRST, then connect providers in the background —
     Gmail's OAuth refresh can take ~30 s and must not delay the handshake.
"""

from __future__ import annotations

import asyncio
import os
import sys

import anyio
from mcp.server.stdio import stdio_server

from .app import build_context
from .core.config import load_config, validate_config
from .notifications.digest_source import produce_digest_notification, produce_urgent_highlights
from .notifications.notifier import DesktopNotifier
from .notifications.scheduler import DigestScheduler
from .server import create_server
from .utils.errors import get_error_message
from .utils.logger import logger

_log = logger.child("boot")


def _poll_minutes() -> float:
    try:
        return max(0.0, float(os.environ.get("URGENT_POLL_MINUTES", "0") or 0))
    except ValueError:
        return 0.0


async def main() -> None:
    config = load_config()
    logger.set_level(config.log_level)
    for issue in validate_config(config):
        _log.warn(f"Config: {issue}")

    ctx, _llm = build_context(config)
    providers = ctx.providers
    scheduler = DigestScheduler(
        config.schedule,
        DesktopNotifier(config.notifications),
        produce_digest=lambda: produce_digest_notification(ctx),
        produce_urgent=lambda: produce_urgent_highlights(ctx),
        urgent_poll_minutes=_poll_minutes(),
    )
    ctx.scheduler = scheduler
    server = create_server(ctx)

    async def connect_in_background() -> None:
        if not providers.has_accounts():
            _log.warn("No provider accounts configured — tools will return empty results until you configure one.")
        else:
            try:
                results = await providers.connect_all()
                ok = sum(1 for r in results if r["connected"])
                _log.info(
                    f"Connected {ok}/{len(results)} provider MCP server(s)",
                    {"results": [f"{r['accountId']}:{'ok' if r['connected'] else 'fail'}" for r in results]},
                )
            except Exception as e:
                _log.error("Provider connection failed", e)
        scheduler.start()

    background = asyncio.create_task(connect_in_background())
    try:
        async with stdio_server() as (read, write):
            _log.info("email-orchestrator MCP server is running on stdio")
            await server.run(read, write, server.create_initialization_options())
    finally:
        # stdin closed (client quit) or Ctrl+C: tidy up the child processes we spawned.
        _log.info("Shutting down...")
        background.cancel()
        scheduler.stop()
        with anyio.CancelScope(shield=True):
            await providers.disconnect_all()


def run() -> None:
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        _log.error("Fatal error during startup", e)
        sys.stderr.write(f"Fatal: {get_error_message(e)}\n")
        sys.exit(1)


if __name__ == "__main__":
    run()

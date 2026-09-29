"""Call any orchestrator tool from the terminal, without Claude Desktop in the loop.

    python -m email_orchestrator.setup.run_tool inbox_summary '{"maxPerAccount": 5}'
    python -m email_orchestrator.setup.run_tool account_status '{"refresh": true}'

Debugging analogy: instead of testing the car by driving it through a
drive-through (Claude Desktop → MCP → tool), put it on the lift and turn the
wheels directly. Same code path as the server's ``tools/call`` handler.
"""

from __future__ import annotations

import asyncio
import json
import sys

from ..app import build_context
from ..core.config import load_config
from ..server import dispatch
from ..tools import TOOLS_BY_NAME


async def main(argv: list[str]) -> int:
    if not argv or argv[0] not in TOOLS_BY_NAME:
        print("usage: python -m email_orchestrator.setup.run_tool <tool> ['<json args>']")
        print("tools: " + ", ".join(TOOLS_BY_NAME))
        return 2
    args = json.loads(argv[1]) if len(argv) > 1 else {}
    ctx, _ = build_context(load_config())
    try:
        result = await dispatch(argv[0], args, ctx)
    finally:
        await ctx.providers.disconnect_all()
    print(result.content[0].text)
    if "--json" in argv and result.structuredContent is not None:
        print(json.dumps(result.structuredContent, indent=2, ensure_ascii=False))
    return 1 if result.isError else 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(asyncio.run(main(sys.argv[1:])))

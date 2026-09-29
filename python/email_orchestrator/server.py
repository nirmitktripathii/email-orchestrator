"""The orchestrator's own MCP server — the side Claude Desktop / Antigravity talk to.

Two request types matter:
* ``tools/list`` → "what buttons do you have?"  → the 17 tool definitions;
* ``tools/call`` → "press this button with these arguments" → run the handler.
"""

from __future__ import annotations

import time
from typing import Any

import mcp.types as types
from mcp.server.lowlevel import Server

from .tools import ALL_TOOLS, TOOLS_BY_NAME, ToolContext
from .utils.errors import get_error_message
from .utils.logger import logger

_log = logger.child("server")

SERVER_NAME = "email-orchestrator"
SERVER_VERSION = "1.0.0"


def as_structured(data: Any) -> dict[str, Any] | None:
    """structuredContent must be a JSON *object*: wrap lists and primitives."""
    if data is None:
        return None
    if isinstance(data, list):
        return {"items": data}
    if isinstance(data, dict):
        return data
    return {"value": data}


async def dispatch(name: str, arguments: dict[str, Any] | None, ctx: ToolContext) -> types.CallToolResult:
    """Run one tool call. Never raises: failures become ``isError`` results the assistant can read."""
    tool = TOOLS_BY_NAME.get(name)
    if tool is None:
        _log.warn("Unknown tool requested", {"name": name})
        return types.CallToolResult(content=[types.TextContent(type="text", text=f"Unknown tool: {name}")], isError=True)
    start = time.monotonic()
    try:
        output = await tool.handler(arguments or {}, ctx)
        _log.info("Tool executed", {"name": name, "ms": int((time.monotonic() - start) * 1000)})
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=output.text)],
            structuredContent=as_structured(output.data),
        )
    except Exception as e:
        _log.error("Tool execution failed", e, {"name": name})
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=f"❌ {name} failed: {get_error_message(e)}")], isError=True
        )


def create_server(ctx: ToolContext) -> Server:
    server: Server = Server(SERVER_NAME, version=SERVER_VERSION)

    @server.list_tools()
    async def _list_tools() -> list[types.Tool]:
        return [types.Tool(name=t.name, description=t.description, inputSchema=t.input_schema) for t in ALL_TOOLS]

    # validate_input=False: the handlers coerce "25"→25 and "true"→True themselves, matching the
    # TypeScript server; strict schema validation would reject those harmless variations.
    @server.call_tool(validate_input=False)
    async def _call_tool(name: str, arguments: dict[str, Any]) -> types.CallToolResult:
        return await dispatch(name, arguments, ctx)

    _log.info(f"MCP server created with {len(ALL_TOOLS)} tools")
    return server

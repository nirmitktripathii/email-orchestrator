/**
 * @module server
 * @description Builds the orchestrator MCP server (the side that Claude Desktop /
 * Antigravity connect to) using the stable low-level Server API, and dispatches
 * ListTools / CallTool against the tool registry.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toolCatalog, type ToolContext } from './tools/index.js';
import { getErrorMessage } from './utils/errors.js';
import { logger } from './utils/logger.js';

const srvLogger = logger.child('server');

export const SERVER_INFO = { name: 'email-orchestrator', version: '1.0.0' } as const;

/** Wrap a tool's data payload so structuredContent is always a JSON object. */
function asStructured(data: unknown): Record<string, unknown> | undefined {
  if (data === undefined || data === null) return undefined;
  if (Array.isArray(data)) return { items: data };
  if (typeof data === 'object') return data as Record<string, unknown>;
  return { value: data };
}

export interface ServerOptions {
  /**
   * Tools this server may list and run. Omitted means all of them (the local stdio default).
   * A hosted server passes an explicit list, and a tool outside it is neither listed nor callable,
   * so a model cannot reach a tool the operator did not switch on.
   */
  readonly allowedTools?: ReadonlySet<string>;
}

export function createServer(ctx: ToolContext, options: ServerOptions = {}): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  const catalog = toolCatalog(ctx);
  const offered = catalog.filter(t => !options.allowedTools || options.allowedTools.has(t.name));
  const offeredByName = new Map(offered.map(t => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: offered.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: rawArgs } = request.params;
    const tool = offeredByName.get(name);
    if (!tool) {
      srvLogger.warn('Unknown tool requested', { name });
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }

    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const start = Date.now();
    try {
      const output = await tool.handler(args, ctx);
      srvLogger.info('Tool executed', { name, ms: Date.now() - start });
      const structured = asStructured(output.data);
      return {
        content: [{ type: 'text', text: output.text }],
        ...(structured ? { structuredContent: structured } : {}),
      };
    } catch (error) {
      srvLogger.error('Tool execution failed', error, { name });
      return {
        content: [{ type: 'text', text: `❌ ${name} failed: ${getErrorMessage(error)}` }],
        isError: true,
      };
    }
  });

  srvLogger.info(`MCP server created with ${offered.length} of ${catalog.length} tools`);
  return server;
}

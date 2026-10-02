/**
 * @module tools
 * @description Aggregates every orchestrator MCP tool into one registry the server
 * uses for ListTools / CallTool dispatch.
 */

import type { ToolDefinition } from './tool-context.js';
import { inboxTools } from './inbox-tools.js';
import { emailTools } from './email-tools.js';
import { batchTools } from './batch-tools.js';
import { statusTools } from './status-tools.js';
import { scheduleTools } from './schedule-tools.js';
import { sendTools } from './send-tools.js';
import type { ToolContext } from './tool-context.js';

export * from './tool-context.js';

/** All tools, in a sensible presentation order. */
export const allTools: readonly ToolDefinition[] = [
  ...inboxTools,
  ...emailTools,
  ...batchTools,
  ...statusTools,
  ...scheduleTools,
];

/**
 * The tools a server built on this context may offer: everything in `allTools`, plus the send tool
 * only if sending was switched on. Default installs therefore have no send tool to hijack.
 */
export function toolCatalog(ctx: Pick<ToolContext, 'send'>): readonly ToolDefinition[] {
  return ctx.send ? [...allTools, ...sendTools] : allTools;
}

/** Fast lookup by tool name. */
export const toolsByName: ReadonlyMap<string, ToolDefinition> = new Map(
  allTools.map(t => [t.name, t]),
);

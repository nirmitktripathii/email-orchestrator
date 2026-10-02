#!/usr/bin/env node
/**
 * @module http
 * @description Hosted entry point: the same tools as the stdio server, over Streamable HTTP, for a
 * caller that is not on this machine (an agent platform, say).
 *
 * Differences from index.ts, all deliberate:
 *   - Needs `MCP_HTTP_TOKEN` and an explicit `EMAIL_HTTP_TOOLS` list, or it refuses to start.
 *   - Holds only the demo mailbox unless real mailboxes are explicitly allowed.
 *   - Offers only the listed tools. The schedule tools and desktop toasts are not started: a
 *     server has no desktop, and no caller should be able to change a schedule.
 *   - Binds 0.0.0.0 on `PORT` (what a host such as Render expects).
 */

import { createServer as createHttpServer } from 'node:http';
import { loadConfig, validateConfig } from './core/config.js';
import { buildToolContext } from './bootstrap.js';
import { createServer } from './server.js';
import { createHttpHandler } from './http-app.js';
import { assertHostedAccounts, loadHostedConfig } from './hosted-config.js';
import { toolCatalog } from './tools/index.js';
import { logger } from './utils/logger.js';
import { getErrorMessage } from './utils/errors.js';

const bootLogger = logger.child('boot');

async function main(): Promise<void> {
  const config = loadConfig();
  logger.setLevel(config.logLevel);
  for (const issue of validateConfig(config)) {
    bootLogger.warn(`Config: ${issue}`);
  }
  assertHostedAccounts(config.accounts, process.env);
  const ctx = buildToolContext(config);
  const hosted = loadHostedConfig(process.env, toolCatalog(ctx).map(t => t.name));
  const handler = createHttpHandler({
    token: hosted.token,
    buildServer: () => createServer(ctx, { allowedTools: hosted.tools }),
  });

  const http = createHttpServer((req, res) => void handler(req, res));
  await new Promise<void>(resolve => http.listen(hosted.port, '0.0.0.0', resolve));
  bootLogger.info(`email-orchestrator MCP server is running on http://0.0.0.0:${hosted.port}/mcp`, {
    tools: [...hosted.tools],
  });

  // Serve first, connect later: a slow mailbox login must not hold up the health check.
  if (ctx.providers.hasAccounts()) {
    ctx.providers
      .connectAll()
      .then(results => {
        const ok = results.filter(r => r.connected).length;
        bootLogger.info(`Connected ${ok}/${results.length} provider MCP server(s)`);
      })
      .catch(error => bootLogger.error('Provider connection failed', error));
  } else {
    bootLogger.warn('No provider accounts configured: the offered tools will find no mail.');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    bootLogger.info(`Received ${signal}; shutting down...`);
    http.close();
    await ctx.providers.disconnectAll();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(error => {
  bootLogger.error('Fatal error during startup', error);
  process.stderr.write(`Fatal: ${getErrorMessage(error)}\n`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * @module index
 * @description Entry point for the email-orchestrator MCP server.
 *
 * Boot sequence:
 *   1. Load + validate configuration (.env).
 *   2. Build the LLM client and AI engines (summarizer / categorizer / recommender / enrichment).
 *   3. Build the provider manager and connect to each downstream MCP server.
 *   4. Assemble the tool context; start the digest scheduler + urgent monitor.
 *   5. Serve tools to Claude Desktop / Antigravity over stdio.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig, validateConfig } from './core/config.js';
import { DesktopNotifier } from './notifications/notifier.js';
import { DigestScheduler } from './notifications/scheduler.js';
import { produceDigestNotification, produceUrgentHighlights } from './notifications/digest-source.js';
import { createServer } from './server.js';
import { buildToolContext } from './bootstrap.js';
import { logger } from './utils/logger.js';
import { getErrorMessage } from './utils/errors.js';

const bootLogger = logger.child('boot');

async function main(): Promise<void> {
  const config = loadConfig();
  logger.setLevel(config.logLevel);

  for (const issue of validateConfig(config)) {
    bootLogger.warn(`Config: ${issue}`);
  }

  // --- Engines, providers (constructed now; connected AFTER the server is serving), tool context ---
  const ctx = buildToolContext(config);
  const { providers } = ctx;

  // --- Notifications + scheduler (started once providers are connected) ---
  const notifier = new DesktopNotifier(config.notifications);
  const urgentPollMinutes = Math.max(0, Number(process.env['URGENT_POLL_MINUTES'] ?? '0') || 0);
  const scheduler = new DigestScheduler({
    schedule: config.schedule,
    notifier,
    produceDigest: () => produceDigestNotification(ctx),
    produceUrgent: () => produceUrgentHighlights(ctx),
    urgentPollMinutes,
  });
  ctx.scheduler = scheduler;

  // --- Serve over stdio FIRST, so the MCP client sees us immediately ---
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  bootLogger.info('email-orchestrator MCP server is running on stdio');

  // --- Connect providers in the background ---
  // Some servers (e.g. Gmail) validate/refresh OAuth tokens on startup, which can
  // take ~30s. Doing this after the server is up keeps the orchestrator responsive;
  // tools simply return empty results until connections are established.
  if (providers.hasAccounts()) {
    providers
      .connectAll()
      .then(results => {
        const ok = results.filter(r => r.connected).length;
        bootLogger.info(`Connected ${ok}/${results.length} provider MCP server(s)`, {
          results: results.map(r => `${r.accountId}:${r.connected ? 'ok' : 'fail'}`),
        });
        scheduler.start();
      })
      .catch(error => bootLogger.error('Provider connection failed', error));
  } else {
    bootLogger.warn('No provider accounts configured — tools will return empty results until you configure at least one.');
    scheduler.start();
  }

  // --- Graceful shutdown ---
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    bootLogger.info(`Received ${signal}; shutting down...`);
    scheduler.stop();
    await providers.disconnectAll();
    try {
      await server.close();
    } catch {
      /* ignore */
    }
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

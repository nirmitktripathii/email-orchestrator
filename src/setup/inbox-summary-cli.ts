#!/usr/bin/env node
/**
 * @module setup/inbox-summary-cli
 * @description Runs the SAME cross-account inbox summary as the `inbox_summary`
 * MCP tool, but as a plain CLI — so it is NOT bound by the MCP client's fixed
 * per-call timeout. Enriching N emails at level "summary" is ~2 LLM calls each
 * plus a digest call; across two accounts that easily exceeds the ~60s MCP
 * timeout. Here we control the wall-clock budget ourselves.
 *
 * Usage (from the project root):
 *   npx tsx src/setup/inbox-summary-cli.ts [--max 20] [--unread] [--since 7]
 *                                          [--level category|summary|full]
 *                                          [--no-digest]
 *
 * Env vars are read from .env exactly like the server (LLM_*, GMAIL_*, ZOHO_*).
 * Remember to export the TLS vars the providers need on this machine, e.g.
 *   NODE_EXTRA_CA_CERTS, SSL_CERT_FILE (Avast interception) — see the Claude
 *   Desktop config.
 */

import { stderr, stdout } from 'node:process';

import { loadConfig, validateConfig } from '../orchestrator/core/config.js';
import { LLMClient } from '../orchestrator/ai/llm-client.js';
import { EmailSummarizer } from '../orchestrator/ai/summarizer.js';
import { EmailCategorizer } from '../orchestrator/ai/categorizer.js';
import { ActionRecommender } from '../orchestrator/ai/action-recommender.js';
import { EmailEnrichmentService, type EnrichmentLevel } from '../orchestrator/ai/enrichment.js';
import { ProviderManager } from '../orchestrator/providers/provider-manager.js';
import { buildInboxSummary, formatInboxSummaryText } from '../orchestrator/tools/summary-builder.js';
import { getErrorMessage } from '../orchestrator/utils/errors.js';

/** Log progress to stderr so stdout carries only the final summary text. */
function log(msg: string): void {
  stderr.write(`${msg}\n`);
}

interface CliOptions {
  maxPerAccount: number;
  unreadOnly: boolean;
  sinceDays: number;
  level: EnrichmentLevel;
  includeDigest: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    maxPerAccount: 20,
    unreadOnly: false,
    sinceDays: 0,
    level: 'summary',
    includeDigest: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--max':
      case '-m':
        opts.maxPerAccount = Math.max(1, Number(argv[++i]) || opts.maxPerAccount);
        break;
      case '--unread':
        opts.unreadOnly = true;
        break;
      case '--since':
        opts.sinceDays = Math.max(0, Number(argv[++i]) || 0);
        break;
      case '--level':
      case '-l': {
        const v = argv[++i];
        if (v === 'category' || v === 'summary' || v === 'full') opts.level = v;
        break;
      }
      case '--no-digest':
        opts.includeDigest = false;
        break;
      default:
        if (arg && arg.startsWith('-')) log(`(ignoring unknown flag ${arg})`);
    }
  }
  return opts;
}

function sinceFromDays(days: number): string | undefined {
  if (days <= 0) return undefined;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  const config = loadConfig();
  for (const issue of validateConfig(config)) log(`  • note: ${issue}`);

  // --- Build the exact same engines index.ts assembles ---
  const llm = new LLMClient(config.llm);
  const summarizer = new EmailSummarizer(llm);
  const categorizer = new EmailCategorizer(llm);
  const actionRecommender = new ActionRecommender(llm);
  const enrichment = new EmailEnrichmentService(summarizer, categorizer, actionRecommender, {
    cacheTtlSeconds: config.cache.ttlSeconds,
    maxCacheEntries: config.cache.maxEntries,
  });
  const providers = ProviderManager.fromConfig(config);

  if (!providers.hasAccounts()) {
    log('No provider accounts configured. Run "npm run setup".');
    process.exit(1);
  }

  // --- Connect all downstream provider MCP servers (Gmail stdio, Zoho http) ---
  log(`\nConnecting providers… (LLM: ${config.llm.provider}/${config.llm.model})`);
  const results = await providers.connectAll();
  for (const r of results) {
    log(`  ${r.connected ? '✅' : '❌'} ${r.accountId}: ${r.connected ? 'connected' : `FAILED — ${r.error ?? 'unknown'}`}`);
  }
  if (!results.some(r => r.connected)) {
    log('No providers connected — aborting.');
    await providers.disconnectAll();
    process.exit(1);
  }

  // --- Mirror the inbox_summary tool handler ---
  const since = sinceFromDays(opts.sinceDays);
  log(
    `\nListing up to ${opts.maxPerAccount}/account` +
      `${opts.unreadOnly ? ' (unread only)' : ''}` +
      `${since ? ` since ${since.slice(0, 10)}` : ''}…`,
  );
  const raw = await providers.listAllEmails({
    maxResults: opts.maxPerAccount,
    unreadOnly: opts.unreadOnly,
    ...(since ? { since } : {}),
  });
  log(`  → pulled ${raw.length} email(s) across accounts in ${Date.now() - startedAt}ms`);

  log(`\nEnriching ${raw.length} email(s) at level "${opts.level}" (this is the slow part)…`);
  const enrichStart = Date.now();
  const enriched = await enrichment.enrichMany(raw, opts.level);
  log(`  → enriched in ${Date.now() - enrichStart}ms`);

  let digest = '';
  if (opts.includeDigest) {
    log('\nGenerating narrative digest…');
    const digestStart = Date.now();
    digest = (await summarizer.generateDigest(enriched)).digest;
    log(`  → digest in ${Date.now() - digestStart}ms`);
  }

  const summary = buildInboxSummary(enriched, providers.getStatuses(), digest);
  const text = formatInboxSummaryText(summary, digest);

  log(`\n=== INBOX SUMMARY (total ${Date.now() - startedAt}ms) ===\n`);
  // The summary itself goes to stdout so it can be captured cleanly.
  stdout.write(text + '\n');

  await providers.disconnectAll();
  process.exit(0);
}

main().catch(async error => {
  log(`\nFatal: ${getErrorMessage(error)}`);
  process.exit(1);
});

/**
 * @module bootstrap
 * @description Builds the engines and tool context from configuration. Shared by the stdio entry
 * point (index.ts) and the hosted HTTP entry point (http.ts) so both wire the same things.
 */

import type { AppConfig } from './core/types.js';
import { LLMClient } from './ai/llm-client.js';
import { EmailSummarizer } from './ai/summarizer.js';
import { EmailCategorizer } from './ai/categorizer.js';
import { ActionRecommender } from './ai/action-recommender.js';
import { EmailEnrichmentService } from './ai/enrichment.js';
import { ProviderManager } from './providers/provider-manager.js';
import type { ToolContext } from './tools/index.js';
import { loadSend } from './send/config.js';

/** Providers are constructed here but not connected; the caller connects them once it is serving. */
export function buildToolContext(config: AppConfig): ToolContext {
  const llm = new LLMClient(config.llm);
  const summarizer = new EmailSummarizer(llm);
  const categorizer = new EmailCategorizer(llm);
  const actionRecommender = new ActionRecommender(llm);
  const enrichment = new EmailEnrichmentService(summarizer, categorizer, actionRecommender, {
    cacheTtlSeconds: config.cache.ttlSeconds,
    maxCacheEntries: config.cache.maxEntries,
  });
  const providers = ProviderManager.fromConfig(config);
  // Off unless EMAIL_SEND_ENABLED=true. Without it there is no send tool to offer.
  const send = loadSend(process.env);
  return { config, providers, enrichment, summarizer, categorizer, actionRecommender, ...(send ? { send } : {}) };
}

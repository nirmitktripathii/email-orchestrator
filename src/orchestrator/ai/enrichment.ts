/**
 * @module ai/enrichment
 * @description Fuses the summarizer, categorizer and action-recommender into a
 * single {@link EmailAIEnrichment}, with caching so repeated tool calls on the
 * same email don't re-hit the LLM. Also acts as the email cache / resolver used
 * by the per-email tools (cache-first, then fetch from the provider).
 */

import type { NormalizedEmail, EmailAIEnrichment } from '../core/types.js';
import { LRUCache } from '../core/cache.js';
import { EmailSummarizer } from './summarizer.js';
import { EmailCategorizer } from './categorizer.js';
import { ActionRecommender } from './action-recommender.js';
import type { ProviderManager } from '../providers/provider-manager.js';
import { logger } from '../utils/logger.js';

const enrLogger = logger.child('enrichment');

/** How much AI work to do. Higher levels cost more LLM calls. */
export type EnrichmentLevel = 'category' | 'summary' | 'full';

export interface EnrichmentServiceOptions {
  readonly cacheTtlSeconds?: number;
  readonly maxCacheEntries?: number;
}

export class EmailEnrichmentService {
  private readonly summarizer: EmailSummarizer;
  private readonly categorizer: EmailCategorizer;
  private readonly actionRecommender: ActionRecommender;

  private readonly emailCache: LRUCache<NormalizedEmail>;
  private readonly enrichmentCache: LRUCache<EmailAIEnrichment>;

  constructor(
    summarizer: EmailSummarizer,
    categorizer: EmailCategorizer,
    actionRecommender: ActionRecommender,
    options: EnrichmentServiceOptions = {},
  ) {
    this.summarizer = summarizer;
    this.categorizer = categorizer;
    this.actionRecommender = actionRecommender;

    const ttl = options.cacheTtlSeconds ?? 300;
    const max = options.maxCacheEntries ?? 2000;
    this.emailCache = new LRUCache<NormalizedEmail>(max, ttl);
    // Enrichment is more expensive to produce, so keep it longer.
    this.enrichmentCache = new LRUCache<EmailAIEnrichment>(max, ttl * 4);
  }

  // ---- Email cache / resolution ----

  /** Remember normalized emails so per-email tools can resolve them without a refetch. */
  rememberEmails(emails: readonly NormalizedEmail[]): void {
    for (const email of emails) this.emailCache.set(email.globalId, email);
  }

  getCachedEmail(globalId: string): NormalizedEmail | undefined {
    return this.emailCache.get(globalId);
  }

  /** Resolve an email by global id: cache first, then fetch from its provider. */
  async resolveEmail(globalId: string, providers: ProviderManager): Promise<NormalizedEmail> {
    const cached = this.emailCache.get(globalId);
    if (cached) return cached;
    const fetched = await providers.getEmailByGlobalId(globalId);
    this.emailCache.set(globalId, fetched);
    return fetched;
  }

  // ---- Enrichment ----

  /**
   * Produce (and cache) an {@link EmailAIEnrichment} for one email at the given level.
   * `category` runs one LLM call; `summary` adds a second; `full` also adds actions
   * and task extraction.
   */
  async enrich(email: NormalizedEmail, level: EnrichmentLevel = 'full'): Promise<EmailAIEnrichment> {
    const cacheKey = `${email.globalId}:${level}`;
    const cached = this.enrichmentCache.get(cacheKey);
    if (cached) return cached;

    // If the email already carries enrichment from a prior richer pass, reuse it.
    if (email.aiEnrichment && isAtLeast(levelOf(email.aiEnrichment), level)) {
      return email.aiEnrichment;
    }

    enrLogger.debug('Enriching email', { globalId: email.globalId, level });

    const categorization = await this.categorizer.categorizeEmail(email);

    let summary = '';
    let keyTopics: readonly string[] = [];
    let sentiment: EmailAIEnrichment['sentiment'] = 'neutral';
    if (level === 'summary' || level === 'full') {
      const s = await this.summarizer.summarizeEmail(email);
      summary = s.summary;
      keyTopics = s.keyTopics;
      sentiment = s.sentiment;
    }

    let suggestedActions: EmailAIEnrichment['suggestedActions'] = [];
    let extractedTasks: EmailAIEnrichment['extractedTasks'] = [];
    if (level === 'full') {
      // Give the recommender the freshly-computed category/urgency for better suggestions.
      const withCat: NormalizedEmail = {
        ...email,
        aiEnrichment: { ...blankEnrichment(), category: categorization.category, urgencyScore: categorization.urgencyScore },
      };
      const [actions, tasks] = await Promise.all([
        this.actionRecommender.suggestActions(withCat),
        this.actionRecommender.extractTasks(email),
      ]);
      suggestedActions = actions;
      extractedTasks = tasks;
    }

    const enrichment: EmailAIEnrichment = {
      summary,
      category: categorization.category,
      urgencyScore: categorization.urgencyScore,
      priority: categorization.priority,
      suggestedActions,
      extractedTasks,
      sentiment,
      keyTopics,
      requiresResponse: categorization.requiresResponse,
      ...(categorization.deadlineDetected ? { deadlineDetected: categorization.deadlineDetected } : {}),
      enrichedAt: new Date().toISOString(),
    };

    this.enrichmentCache.set(cacheKey, enrichment);
    return enrichment;
  }

  /** Enrich a batch, returning emails with `aiEnrichment` attached. Concurrency-limited. */
  async enrichMany(
    emails: readonly NormalizedEmail[],
    level: EnrichmentLevel = 'category',
    // Concurrency 4 stays under the Gemini free-tier request rate (empirically:
    // 4 = zero 429s, 8 = frequent RESOURCE_EXHAUSTED). The LLM client also backs
    // off + retries on 429/503, so an occasional burst still recovers rather than
    // dropping the email to an unenriched fallback.
    concurrency = 4,
  ): Promise<NormalizedEmail[]> {
    if (emails.length === 0) return [];
    enrLogger.info(`Enriching ${emails.length} emails at level "${level}" (concurrency ${concurrency})`);

    const out: NormalizedEmail[] = new Array(emails.length);
    for (let i = 0; i < emails.length; i += concurrency) {
      const batch = emails.slice(i, i + concurrency);
      const enriched = await Promise.all(
        batch.map(async email => {
          try {
            const aiEnrichment = await this.enrich(email, level);
            return { ...email, aiEnrichment };
          } catch (error) {
            enrLogger.warn('Enrichment failed; keeping email unenriched', {
              globalId: email.globalId,
              error: error instanceof Error ? error.message : String(error),
            });
            return email;
          }
        }),
      );
      for (let j = 0; j < enriched.length; j++) out[i + j] = enriched[j]!;
    }

    this.rememberEmails(out);
    return out;
  }

  getCacheStats(): { emails: ReturnType<LRUCache<NormalizedEmail>['getStats']>; enrichments: ReturnType<LRUCache<EmailAIEnrichment>['getStats']> } {
    return { emails: this.emailCache.getStats(), enrichments: this.enrichmentCache.getStats() };
  }
}

// ---- helpers ----

const LEVEL_RANK: Record<EnrichmentLevel, number> = { category: 0, summary: 1, full: 2 };

function isAtLeast(have: EnrichmentLevel, want: EnrichmentLevel): boolean {
  return LEVEL_RANK[have] >= LEVEL_RANK[want];
}

/** Infer the level an existing enrichment represents (used to avoid redundant work). */
function levelOf(e: EmailAIEnrichment): EnrichmentLevel {
  if (e.suggestedActions.length > 0 || e.extractedTasks.length > 0) return 'full';
  if (e.summary && e.summary.length > 0) return 'summary';
  return 'category';
}

function blankEnrichment(): EmailAIEnrichment {
  return {
    summary: '',
    category: 'uncategorized',
    urgencyScore: 0,
    priority: 'none',
    suggestedActions: [],
    extractedTasks: [],
    sentiment: 'neutral',
    keyTopics: [],
    requiresResponse: false,
    enrichedAt: new Date().toISOString(),
  };
}

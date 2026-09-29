/**
 * @module ai/categorizer
 * @description Email categorization engine using LLM.
 * Classifies emails into predefined categories with urgency scoring.
 */

import type { NormalizedEmail, EmailCategory, PriorityLevel } from '../core/types.js';
import { EmailCategorySchema, PriorityLevelSchema } from '../core/types.js';
import { LLMClient } from './llm-client.js';
import { buildCategorizePrompt, SYSTEM_PROMPT } from './prompts.js';
import { logger } from '../utils/logger.js';

const catLogger = logger.child('categorizer');

interface CategorizationResult {
  readonly category: EmailCategory;
  readonly urgencyScore: number;
  readonly priority: PriorityLevel;
  readonly requiresResponse: boolean;
  readonly deadlineDetected: string | null;
  readonly reasoning: string;
}

export class EmailCategorizer {
  private readonly llm: LLMClient;

  constructor(llm: LLMClient) {
    this.llm = llm;
  }

  /**
   * Categorize a single email.
   */
  async categorizeEmail(email: NormalizedEmail): Promise<CategorizationResult> {
    catLogger.debug('Categorizing email', { globalId: email.globalId, subject: email.subject });

    try {
      const raw = await this.llm.completeJSON<Record<string, unknown>>({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildCategorizePrompt({
              subject: email.subject,
              from: `${email.from.name} <${email.from.email}>`,
              body: email.body || email.snippet,
              snippet: email.snippet,
            }),
          },
        ],
        temperature: 0.1, // Low temperature for consistent categorization
        // `gemma-4-31b-it` is a THINKING model: ~350-460+ hidden reasoning tokens
        // are spent BEFORE any JSON is emitted, and they count against this budget.
        // 512 was too tight (thinking overran it → empty/MAX_TOKENS → failures). The
        // cap adds no latency (generation stops at STOP), so keep generous headroom.
        maxTokens: 2048,
      });

      // Validate and coerce the response
      const categoryParsed = EmailCategorySchema.safeParse(raw['category']);
      const priorityParsed = PriorityLevelSchema.safeParse(raw['priority']);

      const result: CategorizationResult = {
        category: categoryParsed.success ? categoryParsed.data : 'uncategorized',
        urgencyScore: Math.min(10, Math.max(0, Number(raw['urgencyScore']) || 0)),
        priority: priorityParsed.success ? priorityParsed.data : this.urgencyToPriority(Number(raw['urgencyScore']) || 0),
        requiresResponse: Boolean(raw['requiresResponse']),
        deadlineDetected: typeof raw['deadlineDetected'] === 'string' ? raw['deadlineDetected'] : null,
        reasoning: String(raw['reasoning'] ?? ''),
      };

      catLogger.debug('Email categorized', {
        globalId: email.globalId,
        category: result.category,
        urgency: result.urgencyScore,
      });

      return result;
    } catch (error) {
      catLogger.error('Failed to categorize email', error, { globalId: email.globalId });
      return this.fallbackCategorization(email);
    }
  }

  /**
   * Batch categorize multiple emails.
   * Processes sequentially to avoid rate limits but could be parallelized.
   */
  async categorizeEmails(
    emails: readonly NormalizedEmail[],
    concurrency: number = 3
  ): Promise<Map<string, CategorizationResult>> {
    catLogger.info(`Batch categorizing ${emails.length} emails (concurrency: ${concurrency})`);
    const results = new Map<string, CategorizationResult>();

    // Process in batches for controlled concurrency
    for (let i = 0; i < emails.length; i += concurrency) {
      const batch = emails.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(
        batch.map(email => this.categorizeEmail(email))
      );

      for (let j = 0; j < batch.length; j++) {
        const email = batch[j]!;
        const result = batchResults[j]!;
        if (result.status === 'fulfilled') {
          results.set(email.globalId, result.value);
        } else {
          catLogger.warn('Categorization failed for email', { globalId: email.globalId });
          results.set(email.globalId, this.fallbackCategorization(email));
        }
      }
    }

    return results;
  }

  /**
   * Rule-based fallback categorization when LLM is unavailable.
   */
  private fallbackCategorization(email: NormalizedEmail): CategorizationResult {
    const subject = email.subject.toLowerCase();
    const body = (email.body || email.snippet).toLowerCase();

    // Simple keyword-based categorization
    if (this.matchesPatterns(subject + ' ' + body, ['unsubscribe', 'newsletter', 'sale', 'discount', 'offer', 'promotion', 'deal'])) {
      return { category: 'promotional', urgencyScore: 1, priority: 'low', requiresResponse: false, deadlineDetected: null, reasoning: 'Keyword match: promotional content' };
    }
    if (this.matchesPatterns(subject + ' ' + body, ['urgent', 'asap', 'immediately', 'deadline today', 'due today', 'time sensitive'])) {
      return { category: 'urgent', urgencyScore: 8, priority: 'high', requiresResponse: true, deadlineDetected: null, reasoning: 'Keyword match: urgency indicators' };
    }
    if (this.matchesPatterns(subject + ' ' + body, ['invoice', 'payment', 'billing', 'receipt', 'expense', 'amount due'])) {
      return { category: 'financial', urgencyScore: 5, priority: 'medium', requiresResponse: false, deadlineDetected: null, reasoning: 'Keyword match: financial content' };
    }
    if (this.matchesPatterns(subject + ' ' + body, ['hr', 'appraisal', 'leave', 'policy', 'employee', 'team meeting', 'standup'])) {
      return { category: 'hr-employee', urgencyScore: 4, priority: 'medium', requiresResponse: false, deadlineDetected: null, reasoning: 'Keyword match: HR/employee content' };
    }
    if (this.matchesPatterns(subject + ' ' + body, ['please reply', 'your response', 'let me know', 'follow up', 'following up', 'awaiting', 'pending'])) {
      return { category: 'follow-up', urgencyScore: 5, priority: 'medium', requiresResponse: true, deadlineDetected: null, reasoning: 'Keyword match: follow-up indicators' };
    }

    return { category: 'informational', urgencyScore: 3, priority: 'low', requiresResponse: false, deadlineDetected: null, reasoning: 'Default categorization' };
  }

  private matchesPatterns(text: string, patterns: readonly string[]): boolean {
    return patterns.some(p => text.includes(p));
  }

  private urgencyToPriority(urgencyScore: number): PriorityLevel {
    if (urgencyScore >= 9) return 'critical';
    if (urgencyScore >= 7) return 'high';
    if (urgencyScore >= 5) return 'medium';
    if (urgencyScore >= 3) return 'low';
    return 'none';
  }
}

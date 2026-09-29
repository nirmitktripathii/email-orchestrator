/**
 * @module ai/summarizer
 * @description Email summarization engine using LLM.
 * Generates per-email summaries and batch digest summaries.
 */

import type { NormalizedEmail } from '../core/types.js';
import { LLMClient } from './llm-client.js';
import { buildSummarizePrompt, buildInboxSummaryPrompt, SYSTEM_PROMPT } from './prompts.js';
import { logger } from '../utils/logger.js';

const sumLogger = logger.child('summarizer');

interface SummaryResult {
  readonly summary: string;
  readonly keyTopics: readonly string[];
  readonly sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
}

interface DigestResult {
  readonly digest: string;
  readonly topPriorities: readonly string[];
  readonly actionPlan: string;
}

export class EmailSummarizer {
  private readonly llm: LLMClient;

  constructor(llm: LLMClient) {
    this.llm = llm;
  }

  /**
   * Generate a summary for a single email.
   */
  async summarizeEmail(email: NormalizedEmail): Promise<SummaryResult> {
    sumLogger.debug('Summarizing email', { globalId: email.globalId, subject: email.subject });

    try {
      const result = await this.llm.completeJSON<SummaryResult>({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildSummarizePrompt({
              subject: email.subject,
              from: `${email.from.name} <${email.from.email}>`,
              to: email.to.map(t => t.email).join(', '),
              date: email.date,
              body: email.body || email.snippet,
            }),
          },
        ],
        temperature: 0.2,
        // Thinking-model headroom (see categorizer.ts): reasoning tokens are spent
        // before the JSON body, so keep the cap well above the visible output size.
        maxTokens: 2048,
      });

      sumLogger.debug('Email summarized', { globalId: email.globalId });
      return {
        summary: result.summary ?? '(Summary unavailable)',
        keyTopics: Array.isArray(result.keyTopics) ? result.keyTopics : [],
        sentiment: result.sentiment ?? 'neutral',
      };
    } catch (error) {
      sumLogger.error('Failed to summarize email', error, { globalId: email.globalId });
      return {
        summary: `Subject: ${email.subject}\nFrom: ${email.from.name}\nPreview: ${email.snippet}`,
        keyTopics: [],
        sentiment: 'neutral',
      };
    }
  }

  /**
   * Generate a batch summary / daily digest for multiple emails.
   */
  async generateDigest(emails: readonly NormalizedEmail[]): Promise<DigestResult> {
    if (emails.length === 0) {
      return {
        digest: '📭 No emails to summarize. Your inbox is clean!',
        topPriorities: [],
        actionPlan: 'No actions needed.',
      };
    }

    sumLogger.info(`Generating digest for ${emails.length} emails`);

    try {
      const emailSummaries = emails.map(e => ({
        subject: e.subject,
        from: `${e.from.name} <${e.from.email}>`,
        category: e.aiEnrichment?.category ?? 'uncategorized',
        urgencyScore: e.aiEnrichment?.urgencyScore ?? 0,
        snippet: e.snippet,
        date: e.date,
        accountEmail: e.accountEmail,
      }));

      const result = await this.llm.completeJSON<DigestResult>({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildInboxSummaryPrompt(emailSummaries) },
        ],
        temperature: 0.3,
        maxTokens: 2048,
      });

      return {
        digest: result.digest ?? 'Digest generation failed.',
        topPriorities: Array.isArray(result.topPriorities) ? result.topPriorities : [],
        actionPlan: result.actionPlan ?? '',
      };
    } catch (error) {
      sumLogger.error('Failed to generate digest', error);
      // Fallback: generate a simple text summary
      const fallback = this.generateFallbackDigest(emails);
      return fallback;
    }
  }

  /**
   * Fallback digest when LLM fails.
   */
  private generateFallbackDigest(emails: readonly NormalizedEmail[]): DigestResult {
    const unread = emails.filter(e => !e.isRead).length;
    const byCategory = new Map<string, number>();
    for (const email of emails) {
      const cat = email.aiEnrichment?.category ?? 'uncategorized';
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
    }

    const categoryLines = Array.from(byCategory.entries())
      .map(([cat, count]) => `  • ${cat}: ${count}`)
      .join('\n');

    return {
      digest: `📊 Inbox Overview\n\nTotal emails: ${emails.length}\nUnread: ${unread}\n\nBy Category:\n${categoryLines}`,
      topPriorities: emails
        .filter(e => (e.aiEnrichment?.urgencyScore ?? 0) >= 7)
        .slice(0, 3)
        .map(e => `${e.subject} (from ${e.from.name})`),
      actionPlan: 'Review urgent emails first, then follow-ups.',
    };
  }
}

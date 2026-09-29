/**
 * @module ai/action-recommender
 * @description Recommends actions for emails and generates smart replies.
 */

import type { NormalizedEmail, SuggestedAction, ExtractedTask } from '../core/types.js';
import { LLMClient } from './llm-client.js';
import { buildSuggestActionsPrompt, buildExtractTasksPrompt, buildSmartReplyPrompt, buildExplainEmailPrompt, SYSTEM_PROMPT } from './prompts.js';
import { logger } from '../utils/logger.js';

const actLogger = logger.child('action-recommender');

interface SmartReplyResult {
  readonly subject: string;
  readonly body: string;
  readonly tone: string;
  readonly notes: string;
}

interface ExplainResult {
  readonly explanation: string;
  readonly keyFacts: readonly string[];
  readonly implications: readonly string[];
  readonly expectedActions: readonly string[];
}

export class ActionRecommender {
  private readonly llm: LLMClient;

  constructor(llm: LLMClient) {
    this.llm = llm;
  }

  /**
   * Suggest actions for a specific email.
   */
  async suggestActions(email: NormalizedEmail): Promise<SuggestedAction[]> {
    actLogger.debug('Suggesting actions', { globalId: email.globalId });

    try {
      const raw = await this.llm.completeJSON<{ suggestedActions: SuggestedAction[] }>({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildSuggestActionsPrompt({
              subject: email.subject,
              from: `${email.from.name} <${email.from.email}>`,
              to: email.to.map(t => t.email).join(', '),
              body: email.body || email.snippet,
              category: email.aiEnrichment?.category ?? 'uncategorized',
              urgencyScore: email.aiEnrichment?.urgencyScore ?? 5,
            }),
          },
        ],
        temperature: 0.3,
        maxTokens: 1024,
      });

      return Array.isArray(raw.suggestedActions) ? raw.suggestedActions : [];
    } catch (error) {
      actLogger.error('Failed to suggest actions', error, { globalId: email.globalId });
      return [{
        type: 'reply',
        description: 'Review and respond to this email',
        priority: 'medium',
        reasoning: 'Default suggestion — AI action recommendation unavailable',
      }];
    }
  }

  /**
   * Extract tasks from an email.
   */
  async extractTasks(email: NormalizedEmail): Promise<ExtractedTask[]> {
    actLogger.debug('Extracting tasks', { globalId: email.globalId });

    try {
      const raw = await this.llm.completeJSON<{ tasks: ExtractedTask[] }>({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildExtractTasksPrompt({
              subject: email.subject,
              from: `${email.from.name} <${email.from.email}>`,
              body: email.body || email.snippet,
            }),
          },
        ],
        temperature: 0.2,
        maxTokens: 1024,
      });

      return Array.isArray(raw.tasks) ? raw.tasks : [];
    } catch (error) {
      actLogger.error('Failed to extract tasks', error, { globalId: email.globalId });
      return [];
    }
  }

  /**
   * Generate a smart reply draft.
   */
  async generateSmartReply(
    email: NormalizedEmail,
    recipientName: string,
    options?: { tone?: 'professional' | 'friendly' | 'formal' | 'casual'; intent?: string }
  ): Promise<SmartReplyResult> {
    actLogger.debug('Generating smart reply', { globalId: email.globalId });

    try {
      const result = await this.llm.completeJSON<SmartReplyResult>({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildSmartReplyPrompt({
              subject: email.subject,
              from: `${email.from.name} <${email.from.email}>`,
              body: email.body || email.snippet,
              recipientName,
              tone: options?.tone,
              intent: options?.intent,
            }),
          },
        ],
        temperature: 0.5,
        maxTokens: 1024,
      });

      return {
        subject: result.subject ?? `Re: ${email.subject}`,
        body: result.body ?? '',
        tone: result.tone ?? options?.tone ?? 'professional',
        notes: result.notes ?? '',
      };
    } catch (error) {
      actLogger.error('Failed to generate smart reply', error, { globalId: email.globalId });
      return {
        subject: `Re: ${email.subject}`,
        body: `Thank you for your email. I will review and get back to you shortly.`,
        tone: 'professional',
        notes: 'Auto-generated fallback reply — AI was unavailable.',
      };
    }
  }

  /**
   * Generate a detailed explanation of an email.
   */
  async explainEmail(email: NormalizedEmail): Promise<ExplainResult> {
    actLogger.debug('Explaining email', { globalId: email.globalId });

    try {
      const result = await this.llm.completeJSON<ExplainResult>({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildExplainEmailPrompt({
              subject: email.subject,
              from: `${email.from.name} <${email.from.email}>`,
              to: email.to.map(t => t.email).join(', '),
              body: email.body || email.snippet,
            }),
          },
        ],
        temperature: 0.3,
        maxTokens: 2048,
      });

      return {
        explanation: result.explanation ?? 'Explanation unavailable.',
        keyFacts: Array.isArray(result.keyFacts) ? result.keyFacts : [],
        implications: Array.isArray(result.implications) ? result.implications : [],
        expectedActions: Array.isArray(result.expectedActions) ? result.expectedActions : [],
      };
    } catch (error) {
      actLogger.error('Failed to explain email', error, { globalId: email.globalId });
      return {
        explanation: `This email is from ${email.from.name} regarding "${email.subject}".`,
        keyFacts: [`From: ${email.from.email}`, `Date: ${email.date}`],
        implications: [],
        expectedActions: ['Review the email content'],
      };
    }
  }
}

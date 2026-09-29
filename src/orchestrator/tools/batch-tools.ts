/**
 * @module tools/batch-tools
 * @description Batch processing tools: batch_categorize, batch_summarize,
 * filter_by_category.
 */

import type { NormalizedEmail, EmailCategory } from '../core/types.js';
import { EmailCategorySchema } from '../core/types.js';
import {
  type ToolDefinition,
  type ToolContext,
  requireString,
  optionalNumber,
  optionalStringArray,
} from './tool-context.js';
import { CATEGORY_EMOJI, toHighlight } from './summary-builder.js';

/** Resolve a list of global ids (cache-first), skipping any that fail. */
async function resolveMany(globalIds: readonly string[], ctx: ToolContext): Promise<NormalizedEmail[]> {
  const settled = await Promise.allSettled(globalIds.map(id => ctx.enrichment.resolveEmail(id, ctx.providers)));
  return settled.filter((r): r is PromiseFulfilledResult<NormalizedEmail> => r.status === 'fulfilled').map(r => r.value);
}

const batchCategorizeTool: ToolDefinition = {
  name: 'batch_categorize',
  description:
    'Categorize many emails at once. Provide globalIds to categorize specific emails, or omit them to ' +
    'categorize the most recent emails across all accounts.',
  inputSchema: {
    type: 'object',
    properties: {
      globalIds: { type: 'array', items: { type: 'string' }, description: 'Specific emails to categorize (accountId:messageId).' },
      maxPerAccount: { type: 'number', description: 'If globalIds omitted, how many recent emails per account (default 25).' },
    },
  },
  async handler(args, ctx: ToolContext) {
    const ids = optionalStringArray(args, 'globalIds');
    const emails = ids && ids.length > 0
      ? await resolveMany(ids, ctx)
      : await ctx.providers.listAllEmails({ maxResults: optionalNumber(args, 'maxPerAccount', 25) });

    const enriched = await ctx.enrichment.enrichMany(emails, 'category');
    const text = enriched.length
      ? enriched.map(e => `${CATEGORY_EMOJI[e.aiEnrichment!.category]} [${e.aiEnrichment!.urgencyScore}/10] ${e.subject} — ${e.from.name || e.from.email}`).join('\n')
      : 'No emails to categorize.';
    return { text, data: enriched.map(toHighlight) };
  },
};

const batchSummarizeTool: ToolDefinition = {
  name: 'batch_summarize',
  description: 'Summarize many emails at once. Provide globalIds, or omit to summarize the most recent emails across all accounts.',
  inputSchema: {
    type: 'object',
    properties: {
      globalIds: { type: 'array', items: { type: 'string' }, description: 'Specific emails to summarize (accountId:messageId).' },
      maxPerAccount: { type: 'number', description: 'If globalIds omitted, how many recent emails per account (default 10).' },
    },
  },
  async handler(args, ctx: ToolContext) {
    const ids = optionalStringArray(args, 'globalIds');
    const emails = ids && ids.length > 0
      ? await resolveMany(ids, ctx)
      : await ctx.providers.listAllEmails({ maxResults: optionalNumber(args, 'maxPerAccount', 10) });

    const enriched = await ctx.enrichment.enrichMany(emails, 'summary', 3);
    const text = enriched.length
      ? enriched.map(e => `📩 ${e.subject} — ${e.from.name || e.from.email} (${e.accountEmail})\n${e.aiEnrichment?.summary || e.snippet}`).join('\n\n')
      : 'No emails to summarize.';
    return {
      text,
      data: enriched.map(e => ({ globalId: e.globalId, subject: e.subject, summary: e.aiEnrichment?.summary ?? '' })),
    };
  },
};

const filterByCategoryTool: ToolDefinition = {
  name: 'filter_by_category',
  description:
    'Return all recent emails across all accounts that match a given category ' +
    '(urgent, follow-up, promotional, hr-employee, financial, informational, personal, spam).',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['urgent', 'follow-up', 'promotional', 'hr-employee', 'financial', 'informational', 'personal', 'spam'],
        description: 'The category to filter by.',
      },
      maxPerAccount: { type: 'number', description: 'How many recent emails per account to scan (default 40).' },
    },
    required: ['category'],
  },
  async handler(args, ctx: ToolContext) {
    const parsed = EmailCategorySchema.safeParse(requireString(args, 'category'));
    if (!parsed.success) {
      return { text: `Invalid category. Valid: ${EmailCategorySchema.options.join(', ')}`, data: { error: 'invalid_category' } };
    }
    const category = parsed.data as EmailCategory;
    const maxPerAccount = optionalNumber(args, 'maxPerAccount', 40);

    const raw = await ctx.providers.listAllEmails({ maxResults: maxPerAccount });
    const enriched = await ctx.enrichment.enrichMany(raw, 'category');
    const matches = enriched.filter(e => e.aiEnrichment?.category === category);

    const text = matches.length
      ? `${CATEGORY_EMOJI[category]} ${matches.length} "${category}" email(s):\n\n` +
        matches.map(e => `• [${e.aiEnrichment!.urgencyScore}/10] ${e.subject} — ${e.from.name || e.from.email} (${e.accountEmail})`).join('\n')
      : `No "${category}" emails found in the last ${maxPerAccount} per account.`;
    return { text, data: matches.map(toHighlight) };
  },
};

export const batchTools: readonly ToolDefinition[] = [batchCategorizeTool, batchSummarizeTool, filterByCategoryTool];

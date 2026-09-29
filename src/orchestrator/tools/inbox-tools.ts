/**
 * @module tools/inbox-tools
 * @description Holistic, cross-account inbox tools: inbox_summary, daily_digest,
 * search_all, prioritize_inbox.
 */

import type { NormalizedEmail } from '../core/types.js';
import type { EnrichmentLevel } from '../ai/enrichment.js';
import {
  type ToolDefinition,
  type ToolContext,
  requireString,
  optionalNumber,
  optionalBool,
  optionalString,
} from './tool-context.js';
import { buildInboxSummary, buildDailyDigest, formatInboxSummaryText, toHighlight, CATEGORY_EMOJI } from './summary-builder.js';

function sinceFromDays(days?: number): string | undefined {
  if (days === undefined || days <= 0) return undefined;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function parseLevel(value: string | undefined, fallback: EnrichmentLevel): EnrichmentLevel {
  return value === 'category' || value === 'summary' || value === 'full' ? value : fallback;
}

/** Format a plain list of emails (used by search / prioritize). */
function formatEmailList(emails: readonly NormalizedEmail[], showRank: boolean): string {
  if (emails.length === 0) return 'No matching emails found.';
  return emails
    .map((e, i) => {
      const enr = e.aiEnrichment;
      const cat = enr ? `${CATEGORY_EMOJI[enr.category]} ${enr.category}` : '';
      const urg = enr ? ` [${enr.urgencyScore}/10]` : '';
      const rank = showRank ? `${i + 1}. ` : '• ';
      const read = e.isRead ? '' : ' ✉️';
      return `${rank}${cat}${urg} ${e.subject}${read}\n     ${e.from.name || e.from.email} · ${e.accountEmail} · ${e.date}`;
    })
    .join('\n');
}

const inboxSummaryTool: ToolDefinition = {
  name: 'inbox_summary',
  description:
    'AI-powered summary across ALL connected email accounts: total counts, per-category breakdown ' +
    '(urgent, follow-up, promotional, HR, financial, informational, personal, spam), urgent highlights, ' +
    'items needing a response, and a narrative digest. This is the main "what\'s in my inbox right now" tool.',
  inputSchema: {
    type: 'object',
    properties: {
      maxPerAccount: { type: 'number', description: 'Max emails to pull per account (default 25).' },
      unreadOnly: { type: 'boolean', description: 'Only include unread emails (default false).' },
      sinceDays: { type: 'number', description: 'Only include emails from the last N days.' },
      enrichLevel: {
        type: 'string',
        enum: ['category', 'summary', 'full'],
        description: 'Depth of AI analysis. "category" is fastest; "summary" adds bullet summaries; "full" adds actions/tasks. Default "summary".',
      },
      includeDigest: { type: 'boolean', description: 'Generate a narrative AI digest (default true).' },
    },
  },
  async handler(args, ctx: ToolContext) {
    const maxPerAccount = optionalNumber(args, 'maxPerAccount', 25);
    const unreadOnly = optionalBool(args, 'unreadOnly', false);
    const sinceDays = optionalNumber(args, 'sinceDays', 0);
    const level = parseLevel(optionalString(args, 'enrichLevel'), 'summary');
    const includeDigest = optionalBool(args, 'includeDigest', true);

    const since = sinceFromDays(sinceDays);
    const raw = await ctx.providers.listAllEmails({
      maxResults: maxPerAccount,
      unreadOnly,
      ...(since ? { since } : {}),
    });

    const enriched = await ctx.enrichment.enrichMany(raw, level);
    const digest = includeDigest ? (await ctx.summarizer.generateDigest(enriched)).digest : '';
    const summary = buildInboxSummary(enriched, ctx.providers.getStatuses(), digest);

    return { text: formatInboxSummaryText(summary, digest), data: summary };
  },
};

const dailyDigestTool: ToolDefinition = {
  name: 'daily_digest',
  description:
    'Comprehensive daily email digest across all accounts for a recent time window, grouped by category ' +
    'with a narrative summary, top priorities, and an action plan for the day. Use for the scheduled ' +
    'morning/afternoon/evening rundown.',
  inputSchema: {
    type: 'object',
    properties: {
      sinceHours: { type: 'number', description: 'Look back this many hours (default 24).' },
      maxPerAccount: { type: 'number', description: 'Max emails per account (default 50).' },
      enrichLevel: {
        type: 'string',
        enum: ['category', 'summary', 'full'],
        description: 'AI analysis depth (default "summary").',
      },
    },
  },
  async handler(args, ctx: ToolContext) {
    const sinceHours = optionalNumber(args, 'sinceHours', 24);
    const maxPerAccount = optionalNumber(args, 'maxPerAccount', 50);
    const level = parseLevel(optionalString(args, 'enrichLevel'), 'summary');

    const from = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
    const to = new Date().toISOString();

    const raw = await ctx.providers.listAllEmails({ maxResults: maxPerAccount, since: from });
    const enriched = await ctx.enrichment.enrichMany(raw, level);
    const { digest, topPriorities, actionPlan } = await ctx.summarizer.generateDigest(enriched);
    const narrative = [digest, topPriorities.length ? `\nTop priorities:\n- ${topPriorities.join('\n- ')}` : '', actionPlan ? `\nAction plan: ${actionPlan}` : '']
      .filter(Boolean)
      .join('\n');

    const daily = buildDailyDigest(enriched, ctx.providers.getStatuses(), narrative, { from, to });
    const text = formatInboxSummaryText(daily.summary, narrative);
    return { text, data: daily };
  },
};

const searchAllTool: ToolDefinition = {
  name: 'search_all',
  description: 'Search across ALL connected email accounts simultaneously and return matching emails, newest first.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (provider-native syntax is passed through, e.g. Gmail search operators).' },
      maxResults: { type: 'number', description: 'Max results per account (default 25).' },
      enrich: { type: 'boolean', description: 'Categorize results with AI (default false).' },
    },
    required: ['query'],
  },
  async handler(args, ctx: ToolContext) {
    const query = requireString(args, 'query');
    const maxResults = optionalNumber(args, 'maxResults', 25);
    const enrich = optionalBool(args, 'enrich', false);

    let results = await ctx.providers.searchAll(query, { maxResults });
    if (enrich) results = await ctx.enrichment.enrichMany(results, 'category');
    else ctx.enrichment.rememberEmails(results);

    const text = `🔎 Search "${query}" — ${results.length} result(s):\n\n${formatEmailList(results, false)}`;
    return { text, data: { query, count: results.length, results: results.map(toHighlight) } };
  },
};

const prioritizeInboxTool: ToolDefinition = {
  name: 'prioritize_inbox',
  description:
    'Rank unread emails across all accounts by AI-assessed urgency/importance (0-10), most urgent first. ' +
    'Great for "what should I deal with first".',
  inputSchema: {
    type: 'object',
    properties: {
      maxPerAccount: { type: 'number', description: 'Max unread emails to pull per account (default 40).' },
      unreadOnly: { type: 'boolean', description: 'Restrict to unread (default true).' },
      limit: { type: 'number', description: 'Max ranked emails to return (default 20).' },
    },
  },
  async handler(args, ctx: ToolContext) {
    const maxPerAccount = optionalNumber(args, 'maxPerAccount', 40);
    const unreadOnly = optionalBool(args, 'unreadOnly', true);
    const limit = optionalNumber(args, 'limit', 20);

    const raw = await ctx.providers.listAllEmails({ maxResults: maxPerAccount, unreadOnly });
    const enriched = await ctx.enrichment.enrichMany(raw, 'category');
    const ranked = [...enriched]
      .sort((a, b) => (b.aiEnrichment?.urgencyScore ?? 0) - (a.aiEnrichment?.urgencyScore ?? 0))
      .slice(0, limit);

    const text = `📊 Prioritized inbox (${ranked.length} of ${enriched.length}):\n\n${formatEmailList(ranked, true)}`;
    return { text, data: ranked.map(toHighlight) };
  },
};

export const inboxTools: readonly ToolDefinition[] = [
  inboxSummaryTool,
  dailyDigestTool,
  searchAllTool,
  prioritizeInboxTool,
];

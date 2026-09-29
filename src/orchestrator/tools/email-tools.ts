/**
 * @module tools/email-tools
 * @description Per-email AI tools (mirrors Gmail's Gemini "AI Overview" and more):
 * summarize_email, categorize_email, suggest_actions, smart_reply, explain_email,
 * extract_tasks, detect_urgency.
 *
 * Every tool identifies an email by its global id (`accountId:messageId`), which the
 * inbox/search tools return. None of these send mail; smart_reply can optionally save
 * a DRAFT (never auto-sends).
 */

import type { EmailDraft } from '../core/types.js';
import {
  type ToolDefinition,
  type ToolContext,
  requireString,
  optionalString,
  optionalBool,
} from './tool-context.js';
import { CATEGORY_EMOJI } from './summary-builder.js';

const GLOBAL_ID_SCHEMA = {
  type: 'string',
  description: 'The email\'s global id in "accountId:messageId" form, as returned by inbox_summary/search_all.',
} as const;

const summarizeEmailTool: ToolDefinition = {
  name: 'summarize_email',
  description: 'Generate a concise 3-5 bullet-point AI summary of a specific email (like Gmail\'s Gemini AI Overview), plus key topics and sentiment.',
  inputSchema: { type: 'object', properties: { globalId: GLOBAL_ID_SCHEMA }, required: ['globalId'] },
  async handler(args, ctx: ToolContext) {
    const email = await ctx.enrichment.resolveEmail(requireString(args, 'globalId'), ctx.providers);
    const result = await ctx.summarizer.summarizeEmail(email);
    const text = [
      `📩 ${email.subject}`,
      `From: ${email.from.name || email.from.email} · ${email.accountEmail}`,
      '',
      result.summary,
      result.keyTopics.length ? `\nTopics: ${result.keyTopics.join(', ')}` : '',
      `Sentiment: ${result.sentiment}`,
    ].filter(Boolean).join('\n');
    return { text, data: { globalId: email.globalId, ...result } };
  },
};

const categorizeEmailTool: ToolDefinition = {
  name: 'categorize_email',
  description: 'Classify a specific email into one of 8 categories (urgent, follow-up, promotional, hr-employee, financial, informational, personal, spam) with an urgency score (0-10) and reasoning.',
  inputSchema: { type: 'object', properties: { globalId: GLOBAL_ID_SCHEMA }, required: ['globalId'] },
  async handler(args, ctx: ToolContext) {
    const email = await ctx.enrichment.resolveEmail(requireString(args, 'globalId'), ctx.providers);
    const c = await ctx.categorizer.categorizeEmail(email);
    const text = [
      `${CATEGORY_EMOJI[c.category]} Category: ${c.category}`,
      `Urgency: ${c.urgencyScore}/10 · Priority: ${c.priority}`,
      `Requires response: ${c.requiresResponse ? 'yes' : 'no'}`,
      c.deadlineDetected ? `Deadline: ${c.deadlineDetected}` : '',
      c.reasoning ? `\n${c.reasoning}` : '',
    ].filter(Boolean).join('\n');
    return { text, data: { globalId: email.globalId, ...c } };
  },
};

const suggestActionsTool: ToolDefinition = {
  name: 'suggest_actions',
  description: 'Recommend 1-3 next actions for a specific email (reply, forward, archive, schedule-meeting, set-reminder, delegate, etc.) with reasoning and, where relevant, a draft reply.',
  inputSchema: { type: 'object', properties: { globalId: GLOBAL_ID_SCHEMA }, required: ['globalId'] },
  async handler(args, ctx: ToolContext) {
    const email = await ctx.enrichment.resolveEmail(requireString(args, 'globalId'), ctx.providers);
    const enriched = email.aiEnrichment ? email : { ...email, aiEnrichment: await ctx.enrichment.enrich(email, 'category') };
    const actions = await ctx.actionRecommender.suggestActions(enriched);
    const text = actions.length
      ? actions.map((a, i) => `${i + 1}. ${a.type} (${a.priority}) — ${a.description}\n   ${a.reasoning}${a.draftContent ? `\n   Draft: ${a.draftContent}` : ''}`).join('\n')
      : 'No specific actions recommended.';
    return { text, data: { globalId: email.globalId, actions } };
  },
};

const smartReplyTool: ToolDefinition = {
  name: 'smart_reply',
  description:
    'Draft a context-aware reply to a specific email. Returns the draft text; it does NOT send. ' +
    'Set saveDraft=true to also save it as a draft in the account (still never sends).',
  inputSchema: {
    type: 'object',
    properties: {
      globalId: GLOBAL_ID_SCHEMA,
      tone: { type: 'string', enum: ['professional', 'friendly', 'formal', 'casual'], description: 'Desired tone (default professional).' },
      intent: { type: 'string', description: 'What you want the reply to accomplish (e.g. "accept the meeting", "ask for an extension").' },
      senderName: { type: 'string', description: 'Your display name to sign the reply as (defaults to the account).' },
      saveDraft: { type: 'boolean', description: 'Also save the reply as a draft in the account (default false). Never sends.' },
    },
    required: ['globalId'],
  },
  async handler(args, ctx: ToolContext) {
    const email = await ctx.enrichment.resolveEmail(requireString(args, 'globalId'), ctx.providers);
    const tone = optionalString(args, 'tone') as 'professional' | 'friendly' | 'formal' | 'casual' | undefined;
    const intent = optionalString(args, 'intent');
    const senderName = optionalString(args, 'senderName') ?? email.accountEmail;
    const saveDraft = optionalBool(args, 'saveDraft', false);

    const reply = await ctx.actionRecommender.generateSmartReply(email, senderName, {
      ...(tone ? { tone } : {}),
      ...(intent ? { intent } : {}),
    });

    let draftNote = '';
    if (saveDraft) {
      const draft: EmailDraft = {
        to: [email.replyTo?.email ?? email.from.email],
        subject: reply.subject,
        body: reply.body,
        ...(email.id ? { inReplyTo: email.id } : {}),
        ...(email.threadId ? { threadId: email.threadId } : {}),
      };
      try {
        const res = await ctx.providers.createDraft(email.accountId, draft);
        draftNote = `\n\n💾 Saved as draft (id: ${res.draftId}) in ${email.accountEmail}. Review and send it yourself.`;
      } catch (error) {
        draftNote = `\n\n⚠️ Could not save draft: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    const text = `✍️ Draft reply (${reply.tone}) — not sent:\n\nSubject: ${reply.subject}\n\n${reply.body}${reply.notes ? `\n\nNotes: ${reply.notes}` : ''}${draftNote}`;
    return { text, data: { globalId: email.globalId, reply, savedDraft: saveDraft } };
  },
};

const explainEmailTool: ToolDefinition = {
  name: 'explain_email',
  description: 'Deep-dive explanation of a specific email: what it is about, why it was sent, key facts, implications, and what is expected of you.',
  inputSchema: { type: 'object', properties: { globalId: GLOBAL_ID_SCHEMA }, required: ['globalId'] },
  async handler(args, ctx: ToolContext) {
    const email = await ctx.enrichment.resolveEmail(requireString(args, 'globalId'), ctx.providers);
    const r = await ctx.actionRecommender.explainEmail(email);
    const text = [
      r.explanation,
      r.keyFacts.length ? `\nKey facts:\n- ${r.keyFacts.join('\n- ')}` : '',
      r.implications.length ? `\nImplications:\n- ${r.implications.join('\n- ')}` : '',
      r.expectedActions.length ? `\nExpected of you:\n- ${r.expectedActions.join('\n- ')}` : '',
    ].filter(Boolean).join('\n');
    return { text, data: { globalId: email.globalId, ...r } };
  },
};

const extractTasksTool: ToolDefinition = {
  name: 'extract_tasks',
  description: 'Extract actionable tasks / to-dos / deliverables from a specific email, with deadlines and assignees where mentioned.',
  inputSchema: { type: 'object', properties: { globalId: GLOBAL_ID_SCHEMA }, required: ['globalId'] },
  async handler(args, ctx: ToolContext) {
    const email = await ctx.enrichment.resolveEmail(requireString(args, 'globalId'), ctx.providers);
    const tasks = await ctx.actionRecommender.extractTasks(email);
    const text = tasks.length
      ? tasks.map((t, i) => `${i + 1}. ${t.description}${t.deadline ? ` (due ${t.deadline})` : ''}${t.assignee ? ` — ${t.assignee}` : ''} [${t.priority}]`).join('\n')
      : 'No actionable tasks found in this email.';
    return { text, data: { globalId: email.globalId, tasks } };
  },
};

const detectUrgencyTool: ToolDefinition = {
  name: 'detect_urgency',
  description: 'Analyze the urgency of a specific email on a 0-10 scale with a priority level and reasoning (also detects any deadline).',
  inputSchema: { type: 'object', properties: { globalId: GLOBAL_ID_SCHEMA }, required: ['globalId'] },
  async handler(args, ctx: ToolContext) {
    const email = await ctx.enrichment.resolveEmail(requireString(args, 'globalId'), ctx.providers);
    const c = await ctx.categorizer.categorizeEmail(email);
    const text = `Urgency: ${c.urgencyScore}/10 (priority: ${c.priority})${c.deadlineDetected ? ` · deadline ${c.deadlineDetected}` : ''}\n${c.reasoning}`;
    return {
      text,
      data: {
        globalId: email.globalId,
        urgencyScore: c.urgencyScore,
        priority: c.priority,
        deadlineDetected: c.deadlineDetected,
        reasoning: c.reasoning,
      },
    };
  },
};

export const emailTools: readonly ToolDefinition[] = [
  summarizeEmailTool,
  categorizeEmailTool,
  suggestActionsTool,
  smartReplyTool,
  explainEmailTool,
  extractTasksTool,
  detectUrgencyTool,
];

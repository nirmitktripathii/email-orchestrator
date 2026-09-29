/**
 * @module notifications/digest-source
 * @description Turns the live inbox into the payloads the scheduler pushes:
 * a daily digest notification and the current set of urgent emails.
 * Kept separate from index.ts so the wiring stays readable.
 */

import type { ToolContext } from '../tools/tool-context.js';
import type { EmailHighlight } from '../core/types.js';
import type { DigestNotification } from './scheduler.js';
import { urgentItems, categoryBreakdown, CATEGORY_EMOJI } from '../tools/summary-builder.js';
import { logger } from '../utils/logger.js';

const dsLogger = logger.child('digest-source');

/** Build a daily-digest notification from the last `sinceHours` of mail. */
export async function produceDigestNotification(
  ctx: ToolContext,
  sinceHours = 24,
): Promise<DigestNotification> {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
  const raw = await ctx.providers.listAllEmails({ maxResults: 40, since });
  const enriched = await ctx.enrichment.enrichMany(raw, 'category');

  const urgent = urgentItems(enriched, 5);
  const breakdown = categoryBreakdown(enriched)
    .map(c => `${CATEGORY_EMOJI[c.category]} ${c.count} ${c.category}`)
    .join(' · ');

  const headline = `📬 ${enriched.length} emails in the last ${sinceHours}h${urgent.length ? ` · ${urgent.length} urgent` : ''}`;
  const body = [
    breakdown,
    ...urgent.slice(0, 3).map(u => `🔴 ${u.subject} (${u.from})`),
  ].filter(Boolean).join('\n');

  dsLogger.debug('Produced digest notification', { total: enriched.length, urgent: urgent.length });
  return { title: headline, message: body || 'No new mail.', urgentItems: urgent };
}

/** Current urgent emails (unread), for the real-time monitor. */
export async function produceUrgentHighlights(ctx: ToolContext): Promise<readonly EmailHighlight[]> {
  const raw = await ctx.providers.listAllEmails({ unreadOnly: true, maxResults: 30 });
  const enriched = await ctx.enrichment.enrichMany(raw, 'category');
  // Only genuinely high-urgency items trigger a real-time push.
  return urgentItems(enriched, 10).filter(h => h.urgencyScore >= 8);
}

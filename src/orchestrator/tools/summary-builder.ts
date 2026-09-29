/**
 * @module tools/summary-builder
 * @description Pure functions that turn enriched emails into InboxSummary /
 * DailyDigest structures and the human-readable text shown in chat (the
 * "Out of 10 emails today: 2 follow-ups, 2 urgent…" overview).
 */

import type {
  NormalizedEmail,
  AccountSummary,
  InboxSummary,
  DailyDigest,
  EmailHighlight,
  CategoryCount,
  EmailCategory,
} from '../core/types.js';

/** Emoji per category for compact, scannable output. */
export const CATEGORY_EMOJI: Record<EmailCategory, string> = {
  urgent: '🔴',
  'follow-up': '🟡',
  promotional: '📢',
  'hr-employee': '👔',
  financial: '💳',
  informational: '🟢',
  personal: '👤',
  spam: '🚫',
  uncategorized: '⚪',
};

const ALL_CATEGORIES: readonly EmailCategory[] = [
  'urgent', 'follow-up', 'hr-employee', 'financial',
  'personal', 'informational', 'promotional', 'spam', 'uncategorized',
];

export function toHighlight(email: NormalizedEmail): EmailHighlight {
  const enr = email.aiEnrichment;
  const oneLiner = firstLine(enr?.summary) || email.snippet || email.subject;
  return {
    globalId: email.globalId,
    accountEmail: email.accountEmail,
    subject: email.subject,
    from: email.from.name || email.from.email,
    date: email.date,
    category: enr?.category ?? 'uncategorized',
    urgencyScore: enr?.urgencyScore ?? 0,
    oneLiner: truncate(oneLiner, 140),
  };
}

/** Count emails per category (with unread counts). */
export function categoryBreakdown(emails: readonly NormalizedEmail[]): CategoryCount[] {
  const counts = new Map<EmailCategory, { count: number; unread: number }>();
  for (const email of emails) {
    const cat = email.aiEnrichment?.category ?? 'uncategorized';
    const entry = counts.get(cat) ?? { count: 0, unread: 0 };
    entry.count += 1;
    if (!email.isRead) entry.unread += 1;
    counts.set(cat, entry);
  }
  return ALL_CATEGORIES.filter(c => counts.has(c)).map(c => {
    const e = counts.get(c)!;
    return { category: c, count: e.count, unreadCount: e.unread };
  });
}

/** Per-account rollup, merging live connection status with counts from the emails. */
export function accountSummaries(
  emails: readonly NormalizedEmail[],
  statuses: readonly AccountSummary[],
): AccountSummary[] {
  const byAccount = new Map<string, { total: number; unread: number }>();
  for (const email of emails) {
    const entry = byAccount.get(email.accountId) ?? { total: 0, unread: 0 };
    entry.total += 1;
    if (!email.isRead) entry.unread += 1;
    byAccount.set(email.accountId, entry);
  }
  return statuses.map(s => {
    const counts = byAccount.get(s.accountId);
    return { ...s, totalEmails: counts?.total ?? 0, unreadCount: counts?.unread ?? 0 };
  });
}

export function urgentItems(emails: readonly NormalizedEmail[], limit = 10): EmailHighlight[] {
  return emails
    .filter(e => (e.aiEnrichment?.urgencyScore ?? 0) >= 7 || e.aiEnrichment?.category === 'urgent')
    .sort((a, b) => (b.aiEnrichment?.urgencyScore ?? 0) - (a.aiEnrichment?.urgencyScore ?? 0))
    .slice(0, limit)
    .map(toHighlight);
}

export function actionRequiredItems(emails: readonly NormalizedEmail[], limit = 15): EmailHighlight[] {
  return emails
    .filter(e => e.aiEnrichment?.requiresResponse || e.aiEnrichment?.category === 'follow-up')
    .sort((a, b) => (b.aiEnrichment?.urgencyScore ?? 0) - (a.aiEnrichment?.urgencyScore ?? 0))
    .slice(0, limit)
    .map(toHighlight);
}

/** Assemble a complete InboxSummary. `digest` is the LLM narrative (passed in). */
export function buildInboxSummary(
  emails: readonly NormalizedEmail[],
  statuses: readonly AccountSummary[],
  digest: string,
): InboxSummary {
  return {
    generatedAt: new Date().toISOString(),
    accounts: accountSummaries(emails, statuses),
    totalEmails: emails.length,
    totalUnread: emails.filter(e => !e.isRead).length,
    categoryBreakdown: categoryBreakdown(emails),
    urgentItems: urgentItems(emails),
    actionRequired: actionRequiredItems(emails),
    digest,
  };
}

export function buildDailyDigest(
  emails: readonly NormalizedEmail[],
  statuses: readonly AccountSummary[],
  narrative: string,
  period: { from: string; to: string },
): DailyDigest {
  const summary = buildInboxSummary(emails, statuses, narrative);
  const categorized = groupByCategory(emails);
  return {
    generatedAt: new Date().toISOString(),
    period,
    summary,
    newEmailCount: emails.length,
    topPriorityEmails: urgentItems(emails, 5),
    categorizedEmails: categorized,
    narrativeSummary: narrative,
  };
}

function groupByCategory(emails: readonly NormalizedEmail[]): Record<EmailCategory, EmailHighlight[]> {
  const out = {} as Record<EmailCategory, EmailHighlight[]>;
  for (const cat of ALL_CATEGORIES) out[cat] = [];
  for (const email of emails) {
    const cat = email.aiEnrichment?.category ?? 'uncategorized';
    out[cat].push(toHighlight(email));
  }
  return out;
}

// ============================
// Text formatters (chat output)
// ============================

/** The compact "Out of N emails: X follow-ups, Y urgent…" headline + breakdown. */
export function formatInboxSummaryText(summary: InboxSummary, digest: string): string {
  const lines: string[] = [];
  lines.push(`📬 Inbox Overview — ${summary.totalEmails} emails (${summary.totalUnread} unread) across ${summary.accounts.length} account(s)`);
  lines.push('');

  if (summary.categoryBreakdown.length > 0) {
    const parts = summary.categoryBreakdown.map(
      c => `${CATEGORY_EMOJI[c.category]} ${c.count} ${c.category}${c.unreadCount > 0 ? ` (${c.unreadCount} unread)` : ''}`,
    );
    lines.push(`Breakdown: ${parts.join(' · ')}`);
    lines.push('');
  }

  if (summary.urgentItems.length > 0) {
    lines.push('🔴 Urgent / time-sensitive:');
    for (const item of summary.urgentItems) {
      lines.push(`  • [${item.urgencyScore}/10] ${item.subject} — ${item.from} (${item.accountEmail})`);
      if (item.oneLiner) lines.push(`      ${item.oneLiner}`);
    }
    lines.push('');
  }

  if (summary.actionRequired.length > 0) {
    lines.push('🟡 Needs a response / follow-up:');
    for (const item of summary.actionRequired) {
      lines.push(`  • ${item.subject} — ${item.from} (${item.accountEmail})`);
    }
    lines.push('');
  }

  if (digest) {
    lines.push('📝 Summary:');
    lines.push(digest);
  }

  return lines.join('\n').trim();
}

export function formatAccountStatusText(statuses: readonly AccountSummary[]): string {
  if (statuses.length === 0) return 'No email accounts are configured.';
  const lines = ['📡 Account status:'];
  for (const s of statuses) {
    const dot = s.isConnected ? '🟢 connected' : '🔴 disconnected';
    const synced = s.lastSyncedAt ? ` · last synced ${s.lastSyncedAt}` : '';
    lines.push(`  • ${s.accountEmail || s.accountId} [${s.provider}] — ${dot}${synced}`);
  }
  return lines.join('\n');
}

// ---- small utils ----

function firstLine(text?: string): string {
  if (!text) return '';
  const line = text.split('\n').map(s => s.trim()).find(s => s.length > 0) ?? '';
  return line.replace(/^[•\-*]\s*/, '');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * @module providers/gmail-adapter
 * @description Adapter for the Gmail MCP server (@gongrzhe/server-gmail-autoauth-mcp).
 *
 * That server returns PLAIN TEXT, not JSON, so this adapter parses its two shapes:
 *  - search_emails → blocks of `ID:/Subject:/From:/Date:`
 *  - read_email    → `Thread ID:/Subject:/From:/To:/Date:` headers, blank line, then body
 * Gmail also lists via search, so "listEmails" maps onto the search tool with a query.
 */

import type {
  EmailQueryOptions,
  EmailDraft,
  ProviderOperation,
  NormalizedEmail,
} from '../core/types.js';
import { normalizeEmail, type RawEmailData } from '../core/email-normalizer.js';
import { BaseMcpAdapter } from './provider-adapter.js';

export class GmailAdapter extends BaseMcpAdapter {
  /**
   * Set on the unread-constrained list/search path. The gongrzhe server returns
   * search results as plain text with **no read-state**, so the base normalizer
   * defaults every result to read (`!labelIds.includes('UNREAD')` → true when there
   * are no labels) and the client-side `unreadOnly` filter would then drop them all —
   * which is why `account_status` reported 0 Gmail unread. When the query is already
   * constrained to `is:unread`, the server has done the filtering, so we tag the
   * parsed rows as unread before normalization.
   */
  private pendingUnreadOnly = false;

  protected override preferredToolNames(): Partial<Record<ProviderOperation, readonly string[]>> {
    return {
      listEmails: ['search_emails', 'list_messages', 'list_emails'],
      searchEmails: ['search_emails', 'search_messages'],
      getEmail: ['read_email', 'get_message', 'get_email'],
      createDraft: ['draft_email', 'create_draft'],
    };
  }

  override async listEmails(options: EmailQueryOptions = {}): Promise<NormalizedEmail[]> {
    this.pendingUnreadOnly = options.unreadOnly ?? false;
    try {
      return await super.listEmails(options);
    } finally {
      this.pendingUnreadOnly = false;
    }
  }

  override async searchEmails(query: string, options: EmailQueryOptions = {}): Promise<NormalizedEmail[]> {
    this.pendingUnreadOnly = options.unreadOnly ?? false;
    try {
      return await super.searchEmails(query, options);
    } finally {
      this.pendingUnreadOnly = false;
    }
  }

  protected override buildListArgs(options: EmailQueryOptions): Record<string, unknown> {
    const clauses: string[] = [`in:${(options.folder ?? 'inbox').toLowerCase()}`];
    if (options.unreadOnly) clauses.push('is:unread');
    if (options.since) {
      const days = daysSince(options.since);
      if (days !== undefined) clauses.push(`newer_than:${days}d`);
    }
    const query = clauses.join(' ');
    return { query, maxResults: options.maxResults ?? 25 };
  }

  protected override buildSearchArgs(query: string, options: EmailQueryOptions): Record<string, unknown> {
    // Fold unreadOnly into the Gmail query so the SERVER filters (gongrzhe can't return
    // read-state for us to filter on afterward). extractEmailList then tags the rows unread.
    const q = options.unreadOnly && !/\bis:unread\b/.test(query) ? `${query} is:unread` : query;
    return { query: q, maxResults: options.maxResults ?? 25 };
  }

  protected override buildDraftArgs(draft: EmailDraft): Record<string, unknown> {
    // Gmail MCP server accepts `to` as an array and a `threadId` for replies.
    return {
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      body: draft.body,
      threadId: draft.threadId,
      inReplyTo: draft.inReplyTo,
    };
  }

  /** Parse the plain-text `search_emails` list into raw email objects. */
  protected override extractEmailList(parsed: unknown): RawEmailData[] {
    const records = typeof parsed === 'string' ? parseSearchList(parsed) : super.extractEmailList(parsed);
    // On the unread path the server already filtered to is:unread; mark the rows unread so
    // the normalizer's read-state default (read, since gongrzhe sends no flags) doesn't drop them.
    if (this.pendingUnreadOnly) {
      for (const record of records) record['isRead'] = false;
    }
    return records;
  }

  /**
   * getEmail is overridden because read_email's text has no message-ID line (only
   * Thread ID), so we inject the id we requested to keep globalId stable.
   */
  override async getEmail(id: string): Promise<NormalizedEmail | null> {
    const parsed = await this.callOperation('getEmail', this.buildGetArgs(id));
    let raw: RawEmailData | null;
    if (typeof parsed === 'string') {
      raw = parseFullEmail(parsed);
    } else {
      raw = super.extractEmail(parsed);
    }
    if (!raw) return null;
    raw['id'] = id; // ensure the id matches what was requested
    try {
      return normalizeEmail(raw, this.provider, this.accountId, this.email);
    } catch {
      return null;
    }
  }
}

function daysSince(iso: string): number | undefined {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  const days = Math.ceil((Date.now() - t) / (24 * 60 * 60 * 1000));
  return Math.max(1, days);
}

/** Parse `ID:/Subject:/From:/Date:` blocks (blank-line separated). */
function parseSearchList(text: string): RawEmailData[] {
  const records: RawEmailData[] = [];
  let cur: Record<string, string> | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(ID|Subject|From|Date|To|Snippet):\s?(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2] ?? '';
    if (key === 'ID') {
      if (cur) records.push(cur);
      cur = { id: value };
    } else if (cur) {
      cur[key.toLowerCase()] = value;
    }
  }
  if (cur) records.push(cur);
  return records;
}

/** Parse a single read_email payload: header lines, blank line, then the body. */
function parseFullEmail(text: string): RawEmailData {
  const lines = text.split(/\r?\n/);
  const record: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') { i++; break; } // blank line separates headers from body
    const m = line.match(/^([A-Za-z][A-Za-z ]*?):\s?(.*)$/);
    if (!m) break;
    const key = m[1]!.trim().toLowerCase();
    const value = m[2] ?? '';
    if (key === 'thread id') record['threadId'] = value;
    else if (key === 'message id' || key === 'id') record['id'] = value;
    else record[key] = value; // subject, from, to, date, cc, ...
  }
  record['body'] = lines.slice(i).join('\n').trim();
  if (record['body']) record['snippet'] = record['body'].slice(0, 200);
  return record;
}

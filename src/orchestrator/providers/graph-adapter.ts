/**
 * @module providers/graph-adapter
 * @description Adapter for an **Outlook / Microsoft 365 account reached over the
 * Microsoft Graph API** through an OAuth-based Graph MCP server.
 *
 * When to use this instead of the IMAP path: many Microsoft 365 *work/school*
 * tenants disable IMAP basic-auth by policy, so the app-password IMAP route
 * ({@link ImapAdapter}) cannot connect. Graph uses OAuth (delegated `Mail.Read`)
 * and keeps working. Personal Outlook.com/Hotmail accounts do **not** need this —
 * they work over IMAP with an app password.
 *
 * Graph MCP servers are not standardized in their *tool names* or *argument*
 * names, but the **message JSON they return is the stable, documented Graph
 * shape**. So this adapter:
 *   - Resolves tool names via the account's `toolMap` override first (recommended
 *     for Graph), then a list of common Graph MCP names, then the base fuzzy match.
 *   - Sends argument objects that carry several common aliases (`top`/`count`,
 *     `search`/`query`, `id`/`messageId`) so it drives differently-named servers
 *     without per-server code.
 *   - Maps the standard Graph message shape into {@link RawEmailData}: nested
 *     `from.emailAddress.{name,address}` → flat `{name,email}`, `receivedDateTime`,
 *     `bodyPreview`, `body:{content,contentType}` (HTML flattened to text), and
 *     `isRead`.
 *
 * **Never sends.** `createDraft` throws — the orchestrator drafts text via
 * smart_reply but never posts a draft or message to Graph.
 *
 * See docs/OUTLOOK-GRAPH-SETUP.md for the Azure app registration and wiring.
 */

import type {
  EmailQueryOptions,
  DraftResult,
  ProviderOperation,
} from '../core/types.js';
import { BaseMcpAdapter } from './provider-adapter.js';
import { coerceEmailArray } from './provider-adapter.js';
import type { RawEmailData } from '../core/email-normalizer.js';
import { ProviderConnectionError } from '../utils/errors.js';

export class GraphAdapter extends BaseMcpAdapter {
  protected override preferredToolNames(): Partial<Record<ProviderOperation, readonly string[]>> {
    // Common names across community Graph MCP servers. A `toolMap` override in the
    // account connection always wins (recommended — see the setup doc).
    return {
      listEmails: [
        'list_messages', 'list-messages', 'list_mail_messages', 'list-mail-messages',
        'get_messages', 'list_emails', 'list_inbox', 'mail_list',
      ],
      searchEmails: [
        'search_messages', 'search-messages', 'search_mail', 'search_emails', 'query_messages',
      ],
      getEmail: [
        'get_message', 'get-message', 'get_mail_message', 'read_message', 'get_email', 'mail_get',
      ],
    };
  }

  override async createDraft(): Promise<DraftResult> {
    throw new ProviderConnectionError(
      this.provider,
      'Saving drafts is not supported for the Microsoft Graph adapter (read-only, no-send). ' +
        'smart_reply still returns the drafted reply text for you to send manually.',
      { accountId: this.accountId },
    );
  }

  // ---- Argument builders (alias-rich, so one shape drives many Graph MCP servers) ----

  protected override buildListArgs(options: EmailQueryOptions): Record<string, unknown> {
    const top = clampTop(options.maxResults);
    const folder = options.folder ?? 'Inbox';
    const args: Record<string, unknown> = {
      top, count: top, limit: top, maxResults: top,
      folder, mailbox: folder, folderId: folder,
      // Ask for a body when the server supports it (harmless alias set if not).
      includeBody: true, select: 'subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,isRead,hasAttachments,conversationId,parentFolderId',
    };
    if (options.unreadOnly) {
      args['filter'] = 'isRead eq false';
      args['unreadOnly'] = true;
    }
    return args;
  }

  protected override buildSearchArgs(query: string, options: EmailQueryOptions): Record<string, unknown> {
    const top = clampTop(options.maxResults);
    return {
      search: query, query, q: query, // Graph `$search` (KQL) matches subject/body/from
      top, count: top, limit: top, maxResults: top,
    };
  }

  protected override buildGetArgs(id: string): Record<string, unknown> {
    return { id, messageId: id, message_id: id, includeBody: true };
  }

  // ---- Result extraction (standard Graph message shape → RawEmailData) ----

  protected override extractEmailList(parsed: unknown): RawEmailData[] {
    // Graph lists come back as { value: [...] }; coerceEmailArray also handles
    // { messages:[...] } and bare arrays that some MCP wrappers use.
    const rows = extractGraphArray(parsed);
    return rows.map(mapGraphMessage);
  }

  protected override extractEmail(parsed: unknown): RawEmailData | null {
    const obj = unwrapSingle(parsed);
    return obj ? mapGraphMessage(obj) : null;
  }
}

// ============================
// Free-standing helpers
// ============================

function clampTop(n?: number): number {
  return Math.min(Math.max(n ?? 25, 1), 200);
}

/** Pull the message array out of Graph's `{ value:[...] }` (or common fallbacks). */
function extractGraphArray(parsed: unknown): Array<Record<string, unknown>> {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const value = (parsed as { value?: unknown }).value;
    if (Array.isArray(value)) {
      return value.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
    }
  }
  // Fall back to the base coercion ({messages|emails|data|results|...} / arrays).
  return coerceEmailArray(parsed) as Array<Record<string, unknown>>;
}

/** Unwrap a single Graph message from `{ value:[m] }` / `{ message:{...} }` / bare object. */
function unwrapSingle(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj['value'])) {
    const first = (obj['value'] as unknown[])[0];
    return first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
  }
  if (obj['message'] && typeof obj['message'] === 'object') return obj['message'] as Record<string, unknown>;
  return obj;
}

/** Map one standard Graph message object into normalizer-friendly RawEmailData. */
function mapGraphMessage(m: Record<string, unknown>): RawEmailData {
  const bodyObj = m['body'] as { content?: unknown; contentType?: unknown } | undefined;
  const bodyContent = typeof bodyObj?.content === 'string' ? bodyObj.content : '';
  const isHtml = String(bodyObj?.contentType ?? '').toLowerCase() === 'html';
  const bodyText = isHtml ? htmlToText(bodyContent) : bodyContent;

  return {
    id: m['id'] != null ? String(m['id']) : '',
    subject: m['subject'] != null ? String(m['subject']) : '(No Subject)',
    from: graphContact(m['from'] ?? m['sender']),
    to: graphContactList(m['toRecipients']),
    cc: graphContactList(m['ccRecipients']),
    date: m['receivedDateTime'] != null ? String(m['receivedDateTime']) : undefined,
    snippet: m['bodyPreview'] != null ? String(m['bodyPreview']) : '',
    ...(bodyText ? { text: bodyText } : {}),
    ...(isHtml && bodyContent ? { htmlContent: bodyContent } : {}),
    isRead: Boolean(m['isRead']),
    hasAttachments: Boolean(m['hasAttachments']),
    threadId: m['conversationId'] != null ? String(m['conversationId']) : undefined,
    folder: m['parentFolderId'] != null ? String(m['parentFolderId']) : undefined,
  };
}

/** Graph nests contacts as `{ emailAddress: { name, address } }` — flatten to {name,email}. */
function graphContact(v: unknown): { name: string; email: string } {
  if (v && typeof v === 'object') {
    const ea = (v as { emailAddress?: unknown }).emailAddress ?? v;
    if (ea && typeof ea === 'object') {
      const o = ea as Record<string, unknown>;
      return {
        name: String(o['name'] ?? o['displayName'] ?? ''),
        email: String(o['address'] ?? o['email'] ?? ''),
      };
    }
  }
  if (typeof v === 'string') return { name: v, email: v };
  return { name: '', email: '' };
}

function graphContactList(v: unknown): Array<{ name: string; email: string }> {
  if (!Array.isArray(v)) return [];
  return v.map(graphContact).filter((c) => c.email || c.name);
}

/** Best-effort HTML → plain text so the LLM sees readable content, not markup. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

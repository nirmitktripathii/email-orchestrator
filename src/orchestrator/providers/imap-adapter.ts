/**
 * @module providers/imap-adapter
 * @description Adapter for **imap-mcp-server v2** — the downstream MCP server used
 * for Yahoo, Outlook (personal), and any generic IMAP mailbox reached with an
 * app-specific password.
 *
 * imap-mcp-server is unlike the Gmail/Zoho servers in three ways this adapter has
 * to bridge:
 *
 *  1. **It ignores credential env vars.** Accounts live in a stateful, encrypted
 *     store (`~/.imap-mcp/accounts.json`) and are added via the `imap_add_account`
 *     tool. So on first use we provision THIS account from the credentials in
 *     `connection.env`. Provisioning is idempotent: the server keys accounts by a
 *     random UUID and does **not** dedupe by name, so we `imap_list_accounts`
 *     first and only add when our account name is absent — otherwise every run
 *     would pile up another duplicate.
 *
 *  2. **Every email tool selects an account** by `accountName` (or id). We use
 *     `this.accountId` (e.g. `yahoo-primary`) as the IMAP account name throughout.
 *
 *  3. **Tools are `imap_*` and mailbox/UID oriented.** `listEmails` →
 *     `imap_get_latest_emails`, `searchEmails` → `imap_search_emails`, `getEmail`
 *     → `imap_get_email`. Reads are by numeric **UID within a folder**, so we use
 *     the UID as the email id (the globalId must round-trip to the UID, not the
 *     RFC822 Message-ID) and remember each UID's folder for single reads.
 *
 * The batch list path requests bodies inline (`includeBody`) because the
 * categorizer/summarizer read `email.body` off the *listed* email and never
 * re-fetch — one round-trip per account instead of an N+1 of `imap_get_email`.
 *
 * **Never sends.** `createDraft` throws, and the child process is locked to a
 * read-only tool allowlist (`IMAP_MCP_ENABLED_TOOLS`, set in config.ts) that omits
 * every send/delete/move/flag tool — defense in depth for the no-send invariant.
 */

import type {
  EmailQueryOptions,
  DraftResult,
  NormalizedEmail,
  ProviderOperation,
} from '../core/types.js';
import { BaseMcpAdapter } from './provider-adapter.js';
import type { RawEmailData } from '../core/email-normalizer.js';
import { ProviderConnectionError } from '../utils/errors.js';

const DEFAULT_FOLDER = 'INBOX';
/** Per-message body cap on the batch list path — enough for categorize+summarize
 *  (their prompts slice to 2000–3000 chars) without bloating one N-email response. */
const LIST_BODY_MAX = 4000;

export class ImapAdapter extends BaseMcpAdapter {
  private ready = false;
  /** UID → folder, remembered from list/search so single reads target the right mailbox. */
  private readonly folderByUid = new Map<string, string>();
  /** Folder of the in-flight list/search, so extractEmailList can tag single-folder results. */
  private pendingFolder = DEFAULT_FOLDER;

  protected override preferredToolNames(): Partial<Record<ProviderOperation, readonly string[]>> {
    return {
      listEmails: ['imap_get_latest_emails'],
      searchEmails: ['imap_search_emails'],
      getEmail: ['imap_get_email'],
    };
  }

  // ---- Reconnection hooks ----

  /**
   * imap-mcp-server keeps accounts in per-process state. If the child dropped and a
   * new one starts, that store is gone — so forget our provisioning and folder map,
   * forcing a fresh {@link ensureAccount} on reconnect. Without this, a reconnect
   * would query a UID against an account the new child has never heard of.
   */
  protected override onConnectionLost(): void {
    this.ready = false;
    this.folderByUid.clear();
  }

  /** Re-provision this account into the (possibly brand-new) child on every connect. */
  protected override async afterConnect(): Promise<void> {
    await this.ensureAccount();
  }

  // ---- Public API overrides (provision the account before any operation) ----

  override async listEmails(options: EmailQueryOptions = {}): Promise<NormalizedEmail[]> {
    await this.ensureAccount();
    this.pendingFolder = options.folder ?? DEFAULT_FOLDER;
    return super.listEmails(options);
  }

  override async searchEmails(query: string, options: EmailQueryOptions = {}): Promise<NormalizedEmail[]> {
    await this.ensureAccount();
    this.pendingFolder = options.folder ?? DEFAULT_FOLDER;
    return super.searchEmails(query, options);
  }

  override async getEmail(id: string): Promise<NormalizedEmail | null> {
    await this.ensureAccount();
    return super.getEmail(id);
  }

  override async createDraft(): Promise<DraftResult> {
    // The orchestrator never sends; the IMAP child is also locked to a read-only
    // tool allowlist with no draft/append tool. smart_reply still returns the text.
    throw new ProviderConnectionError(
      this.provider,
      'Saving drafts is not supported for IMAP accounts (read-only tool set). ' +
        'smart_reply still returns the drafted reply text for you to send manually.',
      { accountId: this.accountId },
    );
  }

  // ---- Argument builders (imap-mcp-server's accountName + folder/uid shape) ----

  protected override buildListArgs(options: EmailQueryOptions): Record<string, unknown> {
    // includeBody so the batch categorize/summarize pass has real content in ONE
    // round-trip; unread/since are applied client-side by the base class.
    return {
      accountName: this.accountId,
      folder: options.folder ?? DEFAULT_FOLDER,
      count: clampCount(options.maxResults),
      includeBody: true,
      bodyFormat: 'auto',
      bodyMaxLength: LIST_BODY_MAX,
    };
  }

  protected override buildSearchArgs(query: string, options: EmailQueryOptions): Record<string, unknown> {
    // imap_search_emails takes structured criteria (from/to/subject/body), not one
    // free-text field. We match the query against the SUBJECT — precise and fast,
    // and it keeps promo-heavy inboxes from flooding every hit into a downstream
    // LLM call. unread/since map to the server-side seen/since filters.
    const args: Record<string, unknown> = {
      accountName: this.accountId,
      folder: options.folder ?? DEFAULT_FOLDER,
      subject: query,
    };
    if (options.unreadOnly) args['seen'] = false;
    if (options.since) {
      const since = toImapDate(options.since);
      if (since) args['since'] = since;
    }
    return args;
  }

  protected override buildGetArgs(id: string): Record<string, unknown> {
    return {
      accountName: this.accountId,
      folder: this.folderByUid.get(id) ?? DEFAULT_FOLDER,
      uid: Number(id),
      bodyFormat: 'auto', // substantive text/plain if present, else clean Markdown
    };
  }

  // ---- Result extraction (map imap-mcp-server shapes → normalizer RawEmailData) ----

  protected override extractEmailList(parsed: unknown): RawEmailData[] {
    return asMessageArray(parsed).map((m) => this.mapMessage(m, this.pendingFolder));
  }

  protected override extractEmail(parsed: unknown): RawEmailData | null {
    const container = parsed as { email?: unknown } | null;
    const email =
      container && typeof container === 'object' && 'email' in container ? container.email : parsed;
    if (!email || typeof email !== 'object') return null;
    const folder = String((email as Record<string, unknown>)['folder'] ?? this.pendingFolder);
    return this.mapMessage(email as Record<string, unknown>, folder);
  }

  // ---- Internals ----

  /** Provision this account into imap-mcp-server once, idempotently. */
  private async ensureAccount(): Promise<void> {
    if (this.ready) return;
    const creds = this.readCredentials();

    let existing: Array<Record<string, unknown>> = [];
    try {
      const listed = await this.callToolRaw('imap_list_accounts', {});
      const accounts = (listed as { accounts?: unknown } | null)?.accounts;
      if (Array.isArray(accounts)) {
        existing = accounts.filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null);
      }
    } catch (error) {
      // Non-fatal: if listing fails we still try to add. A duplicate-name add is the
      // only downside, and that only happens if listing is broken (not the norm).
      this.log.warn('IMAP: imap_list_accounts failed; will attempt imap_add_account', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const present = existing.some((a) => String(a['name'] ?? '') === this.accountId);
    if (!present) {
      await this.callToolRaw('imap_add_account', {
        name: this.accountId,
        host: creds.host,
        port: creds.port,
        user: creds.user,
        password: creds.password,
        tls: creds.tls,
        email: this.email || creds.user,
      });
      this.log.info('IMAP: provisioned account', {
        name: this.accountId,
        host: creds.host,
        port: creds.port,
      });
    }
    this.ready = true;
  }

  /** Read this account's IMAP credentials from the connection env (set by config.ts). */
  private readCredentials(): { host: string; port: number; user: string; password: string; tls: boolean } {
    const cenv = this.connection.env ?? {};
    const host = cenv['IMAP_HOST'] ?? '';
    const user = cenv['IMAP_USER'] ?? '';
    const password = cenv['IMAP_PASSWORD'] ?? '';
    const port = Number(cenv['IMAP_PORT'] ?? '993') || 993;
    const tls = (cenv['IMAP_TLS'] ?? 'true') !== 'false';
    if (!host || !user || !password) {
      const prefix = this.provider === 'outlook' ? 'OUTLOOK' : this.provider === 'yahoo' ? 'YAHOO' : 'IMAP';
      throw new ProviderConnectionError(
        this.provider,
        `Missing IMAP credentials for "${this.accountId}". Set ${prefix}_EMAIL and ` +
          `${prefix}_APP_PASSWORD (and host/port if non-default) in .env.`,
        { accountId: this.accountId },
      );
    }
    return { host, port, user, password, tls };
  }

  /**
   * Map one imap-mcp-server message/email object into normalizer-friendly
   * {@link RawEmailData}. Handles both the lightweight list shape and the full
   * `imap_get_email` shape (which adds textContent/markdownContent/htmlContent).
   */
  private mapMessage(m: Record<string, unknown>, fallbackFolder: string): RawEmailData {
    const uid = m['uid'];
    const uidStr = uid != null ? String(uid) : '';
    const flags = Array.isArray(m['flags']) ? (m['flags'] as unknown[]).map(String) : [];
    const folder = String(m['folder'] ?? fallbackFolder);
    if (uidStr) this.folderByUid.set(uidStr, folder);

    // imap-mcp-server renders the body under different keys depending on bodyFormat
    // ("text" → textContent, "markdown" → markdownContent, "auto" → one of them).
    const bodyText = firstString(m['textContent'], m['markdownContent'], m['text'], m['body']);
    const html = firstString(m['htmlContent'], m['html']);
    const keywords = Array.isArray(m['customKeywords']) ? (m['customKeywords'] as unknown[]).map(String) : [];

    return {
      // Use the numeric UID as our id so the globalId round-trips back to a UID that
      // imap_get_email can read (NOT the RFC822 Message-ID).
      id: uidStr,
      uid,
      messageId: m['messageId'] != null ? String(m['messageId']) : undefined,
      subject: m['subject'] != null ? String(m['subject']) : '(No Subject)',
      from: m['from'], // "Name <email>" string — parseContact handles it
      to: m['to'], // string[] — parseContacts handles it
      cc: m['cc'],
      date: m['date'] != null ? String(m['date']) : undefined,
      isRead: flags.includes('\\Seen'),
      isStarred: flags.includes('\\Flagged'),
      folder,
      labels: keywords,
      ...(bodyText ? { text: bodyText, snippet: bodyText } : {}),
      ...(html ? { htmlContent: html } : {}),
    };
  }
}

// ============================
// Free-standing helpers
// ============================

function clampCount(n?: number): number {
  return Math.min(Math.max(n ?? 25, 1), 200);
}

/** Coerce imap-mcp-server's `{ messages:[...] }` / `{ emails:[...] }` / array into rows. */
function asMessageArray(parsed: unknown): Array<Record<string, unknown>> {
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { messages?: unknown } | null)?.messages)
      ? (parsed as { messages: unknown[] }).messages
      : Array.isArray((parsed as { emails?: unknown } | null)?.emails)
        ? (parsed as { emails: unknown[] }).emails
        : [];
  return arr.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
}

/** First non-empty string among the candidates. */
function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** Convert an ISO/date string into imap-mcp-server's `YYYY-MM-DD` `since` filter. */
function toImapDate(value: string): string | undefined {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

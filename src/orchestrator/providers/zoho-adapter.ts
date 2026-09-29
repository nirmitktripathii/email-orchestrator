/**
 * @module providers/zoho-adapter
 * @description Adapter for the official hosted Zoho Mail MCP server
 * (`*.zohomcp.in`, `.in` data center), reached over Streamable HTTP.
 *
 * Zoho's tools mirror its REST API almost 1:1, which the generic adapter cannot
 * drive directly:
 *  - Every call nests arguments under `path_variables` / `query_params`, and
 *    requires the mailbox's internal `accountId` (a long zoid — NOT the org id in
 *    the server URL). Reads additionally require `folderId` + `messageId`.
 *  - `listEmails` requires an explicit `fields` list; `getMessageContent` returns
 *    HTML; dates are epoch-ms strings; addresses are HTML-escaped (`&lt;…&gt;`).
 *  - Failures come back as `{status:'failure'}` with `isError:false`, so they must
 *    be detected from the payload, not the MCP error flag.
 *
 * This adapter resolves the `accountId` (from config or the `getMailAccounts`
 * tool), caches the folder map, maps Zoho's shape into {@link RawEmailData}, and
 * carries `folderId` per message so single-email reads work.
 */

import type {
  EmailQueryOptions,
  DraftResult,
  NormalizedEmail,
  ProviderOperation,
} from '../core/types.js';
import { BaseMcpAdapter } from './provider-adapter.js';
import { normalizeEmail, type RawEmailData } from '../core/email-normalizer.js';
import { ProviderConnectionError } from '../utils/errors.js';

/** Fields requested from listEmails (Zoho requires an explicit list). */
const LIST_FIELDS =
  'summary,subject,messageId,folderId,threadId,fromAddress,sender,toAddress,ccAddress,' +
  'receivedTime,sentDateInGMT,status,hasAttachment,priority,size';

export class ZohoAdapter extends BaseMcpAdapter {
  private accountIdValue?: string;
  private inboxFolderId?: string;
  private readonly folderNameById = new Map<string, string>();
  private readonly folderIdByName = new Map<string, string>();
  private readonly folderIdByMessageId = new Map<string, string>();
  private readonly metaByMessageId = new Map<string, RawEmailData>();
  private ready = false;

  protected override preferredToolNames(): Partial<Record<ProviderOperation, readonly string[]>> {
    return {
      listEmails: ['ZohoMail_listEmails'],
      searchEmails: ['ZohoMail_SearchEmails'],
      getEmail: ['ZohoMail_getMessageContent'],
    };
  }

  // ---- Public API overrides (ensure accountId + folders are resolved first) ----

  override async listEmails(options: EmailQueryOptions = {}): Promise<NormalizedEmail[]> {
    await this.ensureReady();
    return super.listEmails(options);
  }

  override async searchEmails(query: string, options: EmailQueryOptions = {}): Promise<NormalizedEmail[]> {
    await this.ensureReady();
    return super.searchEmails(query, options);
  }

  override async getEmail(id: string): Promise<NormalizedEmail | null> {
    await this.ensureReady();
    const folderId = this.folderIdByMessageId.get(id) ?? this.inboxFolderId;
    if (!folderId) return null;
    const toolName = this.resolveToolName('getEmail'); // ZohoMail_getMessageContent
    let parsed: unknown;
    try {
      parsed = await this.callToolRaw(toolName, {
        path_variables: { accountId: this.accountIdValue, folderId, messageId: id },
        query_params: { includeBlockContent: true },
      });
    } catch (error) {
      this.log.warn('Zoho: getMessageContent failed', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const payload = this.zohoPayload(parsed) as Record<string, unknown> | undefined;
    const html = typeof payload?.['content'] === 'string' ? (payload['content'] as string) : '';
    const meta = this.metaByMessageId.get(id) ?? { id, messageId: id };
    const merged: RawEmailData = {
      ...meta,
      id,
      messageId: id,
      content: htmlToText(html),
      bodyHtml: html,
    };
    try {
      return normalizeEmail(merged, this.provider, this.accountId, this.email);
    } catch {
      return null;
    }
  }

  override async createDraft(): Promise<DraftResult> {
    // No safe draft tool exists in Zoho's enabled set (only send tools, which the
    // orchestrator never uses). smart_reply still returns the drafted text.
    throw new ProviderConnectionError(
      this.provider,
      'Saving drafts is not supported for Zoho with the enabled tool set ' +
        '(no "save draft" tool). smart_reply still returns the drafted reply text.',
      { accountId: this.accountId },
    );
  }

  // ---- Argument builders (Zoho's nested path_variables/query_params shape) ----

  protected override buildListArgs(options: EmailQueryOptions): Record<string, unknown> {
    const query_params: Record<string, unknown> = {
      fields: LIST_FIELDS,
      limit: clampLimit(options.maxResults),
      status: options.unreadOnly ? 'unread' : 'all',
    };
    const folderId = this.resolveFolderId(options.folder);
    if (folderId) query_params['folderId'] = folderId;
    return { path_variables: { accountId: this.accountIdValue }, query_params };
  }

  protected override buildSearchArgs(query: string, options: EmailQueryOptions): Record<string, unknown> {
    return {
      path_variables: { accountId: this.accountIdValue },
      query_params: {
        searchKey: toSearchKey(query),
        limit: clampLimit(options.maxResults),
      },
    };
  }

  // ---- Result extraction (dig into Zoho's `data.data`, map to RawEmailData) ----

  protected override extractEmailList(parsed: unknown): RawEmailData[] {
    if (this.isFailure(parsed)) {
      this.warnFailure(parsed);
      return [];
    }
    return this.zohoArray(parsed).map((z) => this.mapItem(z as Record<string, unknown>));
  }

  protected override extractEmail(parsed: unknown): RawEmailData | null {
    if (this.isFailure(parsed)) {
      this.warnFailure(parsed);
      return null;
    }
    const p = this.zohoPayload(parsed);
    return p && typeof p === 'object' ? this.mapItem(p as Record<string, unknown>) : null;
  }

  // ---- Internals ----

  /** Resolve accountId + folder map once, lazily, after the MCP client connects. */
  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    this.accountIdValue = this.connection.accountId ?? (await this.fetchAccountId());
    if (!this.accountIdValue) {
      throw new ProviderConnectionError(
        this.provider,
        'Could not determine Zoho mailbox accountId. Set ZOHO_MAIL_ACCOUNT_ID, ' +
          'or enable the Account tool group (getMailAccounts) in the Zoho MCP console.',
        { accountId: this.accountId },
      );
    }
    await this.loadFolders();
    this.ready = true;
  }

  /** Fetch the default mailbox's accountId via the getMailAccounts tool. */
  private async fetchAccountId(): Promise<string | undefined> {
    const tool =
      this.discoveredTools.find((n) => /getMailAccounts/i.test(n)) ??
      this.discoveredTools.find((n) => /(getAll)?(User)?Accounts?$/i.test(n));
    if (!tool) return undefined;
    const parsed = await this.callToolRaw(tool, { path_variables: {}, query_params: {} });
    const accounts = this.zohoArray(parsed) as Array<Record<string, unknown>>;
    const chosen = accounts.find((a) => a['isDefaultAccount']) ?? accounts[0];
    const id = chosen?.['accountId'];
    return id != null ? String(id) : undefined;
  }

  /** Load the folder list to map folderId <-> name and find the Inbox. */
  private async loadFolders(): Promise<void> {
    const tool = this.discoveredTools.find((n) => /getAllFolders/i.test(n));
    if (!tool || !this.accountIdValue) return;
    try {
      const parsed = await this.callToolRaw(tool, {
        path_variables: { accountId: this.accountIdValue },
        query_params: { fields: 'folderId,folderName,folderType,path' },
      });
      for (const f of this.zohoArray(parsed)) {
        const o = f as Record<string, unknown>;
        const fid = o['folderId'] != null ? String(o['folderId']) : '';
        const fname = String(o['folderName'] ?? '');
        if (!fid) continue;
        this.folderNameById.set(fid, fname);
        if (fname) this.folderIdByName.set(fname.toLowerCase(), fid);
        if (!this.inboxFolderId && String(o['folderType']).toLowerCase() === 'inbox' && fname.toLowerCase() === 'inbox') {
          this.inboxFolderId = fid;
        }
      }
      if (!this.inboxFolderId) this.inboxFolderId = this.folderIdByName.get('inbox');
    } catch (error) {
      this.log.warn('Zoho: failed to load folders', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resolveFolderId(folder?: string): string | undefined {
    if (!folder) return undefined; // no folder => Zoho's all-folder view (catches Newsletter etc.)
    const key = folder.toLowerCase();
    if (key === 'inbox') return this.inboxFolderId ?? this.folderIdByName.get('inbox');
    return this.folderIdByName.get(key);
  }

  /** Map a raw Zoho email object into normalizer-friendly RawEmailData. */
  private mapItem(z: Record<string, unknown>): RawEmailData {
    const messageId = String(z['messageId'] ?? z['id'] ?? '');
    const folderId = z['folderId'] != null ? String(z['folderId']) : undefined;
    if (messageId && folderId) this.folderIdByMessageId.set(messageId, folderId);

    const receivedMs = Number(z['receivedTime'] ?? z['sentDateInGMT'] ?? 0);
    const raw: RawEmailData = {
      id: messageId,
      messageId,
      subject: decodeEntities(String(z['subject'] ?? '')),
      from: { name: decodeEntities(String(z['sender'] ?? '')), email: cleanAddress(z['fromAddress']) },
      to: cleanAddressList(z['toAddress']),
      cc: cleanAddressList(z['ccAddress']),
      date: receivedMs > 0 ? new Date(receivedMs).toISOString() : undefined,
      snippet: decodeEntities(String(z['summary'] ?? '')),
      isRead: String(z['status'] ?? '') !== '0',
      hasAttachments: String(z['hasAttachment'] ?? '0') === '1',
      folder: folderId ? this.folderNameById.get(folderId) ?? folderId : undefined,
      threadId: z['threadId'] != null ? String(z['threadId']) : undefined,
    };
    if (messageId) this.metaByMessageId.set(messageId, raw);
    return raw;
  }

  /** Navigate Zoho's doubly-nested `{...,data:{status,data:<payload>}}` envelope. */
  private zohoData(parsed: unknown): unknown {
    const p = parsed as { data?: { data?: unknown } } | undefined;
    if (p?.data?.data !== undefined) return p.data.data;
    if (Array.isArray((p as { data?: unknown })?.data)) return (p as { data: unknown }).data;
    if (Array.isArray(parsed)) return parsed;
    return (p as { data?: unknown })?.data ?? parsed;
  }

  private zohoArray(parsed: unknown): unknown[] {
    const d = this.zohoData(parsed);
    if (Array.isArray(d)) return d;
    return d && typeof d === 'object' ? [d] : [];
  }

  private zohoPayload(parsed: unknown): unknown {
    const d = this.zohoData(parsed);
    return Array.isArray(d) ? d[0] : d;
  }

  private isFailure(parsed: unknown): boolean {
    const p = parsed as { status?: unknown; data?: { status?: { code?: unknown } } } | undefined;
    if (p?.status === 'failure') return true;
    const code = p?.data?.status?.code;
    return typeof code === 'number' && code >= 400;
  }

  private warnFailure(parsed: unknown): void {
    const p = parsed as {
      data?: { data?: { message?: unknown }; message?: unknown; status?: { description?: unknown } };
    };
    const msg =
      p?.data?.data?.message ?? p?.data?.message ?? p?.data?.status?.description ?? 'unknown error';
    this.log.warn('Zoho tool returned failure', { message: String(msg).slice(0, 200) });
  }
}

// ============================
// Free-standing helpers
// ============================

function clampLimit(n?: number): number {
  return Math.min(Math.max(n ?? 25, 1), 200);
}

/** Convert a plain query into Zoho's `{field}:{value}` searchKey (default: full-text). */
function toSearchKey(query: string): string {
  const q = query.trim();
  if (!q) return 'entire:';
  if (/^[a-zA-Z]+:/.test(q) || q.includes('::') || q.includes(':or:')) return q; // already Zoho syntax
  return `entire:${q}`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Extract a bare email address from Zoho's escaped `Name <a@b>` / `<a@b>` / `a@b`. */
function cleanAddress(v: unknown): string {
  if (v == null) return '';
  const s = decodeEntities(String(v)).trim();
  if (!s || /^not provided$/i.test(s)) return '';
  return s
    .replace(/^[^<]*<\s*/, '') // drop display name + opening bracket, if present
    .replace(/\s*>.*$/, '')
    .replace(/[<>]/g, '')
    .trim();
}

function cleanAddressList(v: unknown): Array<{ name: string; email: string }> {
  if (v == null) return [];
  const s = decodeEntities(String(v)).trim();
  if (!s || /^not provided$/i.test(s)) return [];
  return s
    .split(',')
    .map((part) => ({
      name: '',
      email: part.replace(/^[^<]*<\s*/, '').replace(/\s*>.*$/, '').replace(/[<>]/g, '').trim(),
    }))
    .filter((c) => c.email);
}

/** Best-effort HTML → plain text for AI processing. */
function htmlToText(html: string): string {
  if (!html) return '';
  return decodeEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

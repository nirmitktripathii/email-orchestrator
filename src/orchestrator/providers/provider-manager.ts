/**
 * @module providers/provider-manager
 * @description Owns every provider adapter and provides the cross-account
 * aggregation the orchestrator tools depend on. All fan-out is resilient: one
 * account failing never takes down a whole-inbox query.
 */

import type {
  AppConfig,
  EmailAccount,
  NormalizedEmail,
  EmailQueryOptions,
  EmailDraft,
  DraftResult,
  AccountSummary,
} from '../core/types.js';
import { BaseMcpAdapter, type ProviderAdapter } from './provider-adapter.js';
import { GmailAdapter } from './gmail-adapter.js';
import { ZohoAdapter } from './zoho-adapter.js';
import { ImapAdapter } from './imap-adapter.js';
import { GraphAdapter } from './graph-adapter.js';
import { logger } from '../utils/logger.js';
import { EmailNotFoundError, getErrorMessage } from '../utils/errors.js';

const mgrLogger = logger.child('provider-manager');

/** Concrete generic adapter for providers without a specialized subclass (e.g. outlook). */
class GenericAdapter extends BaseMcpAdapter {}

/** Split a `${accountId}:${messageId}` global id into its parts. */
export function parseGlobalId(globalId: string): { accountId: string; messageId: string } | null {
  const idx = globalId.indexOf(':');
  if (idx === -1) return null;
  return { accountId: globalId.slice(0, idx), messageId: globalId.slice(idx + 1) };
}

export class ProviderManager {
  private readonly adapters = new Map<string, ProviderAdapter>();

  /**
   * @param accounts Accounts to build adapters from.
   * @param prebuilt Optional ready-made adapters (used for testing / advanced wiring);
   *   when provided, `accounts` is ignored.
   */
  constructor(accounts: readonly EmailAccount[], prebuilt?: readonly ProviderAdapter[]) {
    if (prebuilt) {
      for (const adapter of prebuilt) this.adapters.set(adapter.accountId, adapter);
      mgrLogger.info(`Provider manager initialized with ${this.adapters.size} pre-built adapter(s)`);
      return;
    }
    for (const account of accounts) {
      if (!account.isActive) {
        mgrLogger.info(`Skipping inactive account ${account.id}`);
        continue;
      }
      if (!account.connection) {
        mgrLogger.warn(`Account ${account.id} has no MCP connection — skipping (configure it to enable)`);
        continue;
      }
      try {
        this.adapters.set(account.id, ProviderManager.createAdapter(account));
      } catch (error) {
        mgrLogger.error(`Failed to construct adapter for ${account.id}`, error);
      }
    }
    mgrLogger.info(`Provider manager initialized with ${this.adapters.size} adapter(s)`);
  }

  static fromConfig(config: AppConfig): ProviderManager {
    return new ProviderManager(config.accounts);
  }

  /** Build a manager from ready-made adapters (testing / advanced wiring). */
  static withAdapters(adapters: readonly ProviderAdapter[]): ProviderManager {
    return new ProviderManager([], adapters);
  }

  private static createAdapter(account: EmailAccount): ProviderAdapter {
    switch (account.provider) {
      case 'gmail':
        return new GmailAdapter(account);
      case 'zoho':
        return new ZohoAdapter(account);
      case 'yahoo':
      case 'imap':
        return new ImapAdapter(account);
      case 'outlook':
        // Outlook uses IMAP (personal accounts, app password) or Microsoft Graph
        // (OAuth — needed when a M365 tenant disables IMAP). The IMAP connection
        // carries IMAP_HOST in its child env; a Graph connection does not.
        return account.connection?.env?.['IMAP_HOST']
          ? new ImapAdapter(account)
          : new GraphAdapter(account);
      default:
        // Anything else: generic MCP adapter with auto tool discovery.
        return new GenericAdapter(account);
    }
  }

  // ---- Connection lifecycle ----

  /** Connect every adapter; returns per-account outcome (never throws). */
  async connectAll(): Promise<Array<{ accountId: string; connected: boolean; error?: string }>> {
    const entries = [...this.adapters.values()];
    const results = await Promise.allSettled(entries.map(a => a.connect()));
    return entries.map((adapter, i) => {
      const r = results[i]!;
      if (r.status === 'fulfilled') {
        return { accountId: adapter.accountId, connected: true };
      }
      mgrLogger.warn(`Adapter ${adapter.accountId} failed to connect`, { error: getErrorMessage(r.reason) });
      return { accountId: adapter.accountId, connected: false, error: getErrorMessage(r.reason) };
    });
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled([...this.adapters.values()].map(a => a.disconnect()));
    mgrLogger.info('All adapters disconnected');
  }

  // ---- Lookups ----

  getAdapter(accountId: string): ProviderAdapter | undefined {
    return this.adapters.get(accountId);
  }

  getAdapters(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  getConnectedAdapters(): ProviderAdapter[] {
    return this.getAdapters().filter(a => a.isConnected());
  }

  hasAccounts(): boolean {
    return this.adapters.size > 0;
  }

  // ---- Cross-account operations ----

  /**
   * List emails across all connected accounts. Failures are isolated per account.
   * Returns emails sorted newest-first.
   */
  async listAllEmails(options: EmailQueryOptions = {}): Promise<NormalizedEmail[]> {
    return this.fanOut(adapter => adapter.listEmails(options), 'listAllEmails');
  }

  /** Search across all connected accounts. */
  async searchAll(query: string, options: EmailQueryOptions = {}): Promise<NormalizedEmail[]> {
    return this.fanOut(adapter => adapter.searchEmails(query, options), 'searchAll');
  }

  /** Fetch a single email by its global id (`accountId:messageId`). */
  async getEmailByGlobalId(globalId: string): Promise<NormalizedEmail> {
    const parts = parseGlobalId(globalId);
    if (!parts) throw new EmailNotFoundError(globalId);
    const adapter = this.adapters.get(parts.accountId);
    if (!adapter) throw new EmailNotFoundError(parts.messageId, parts.accountId);
    const email = await adapter.getEmail(parts.messageId);
    if (!email) throw new EmailNotFoundError(parts.messageId, parts.accountId);
    return email;
  }

  /** Create a draft in a specific account (never sends). */
  async createDraft(accountId: string, draft: EmailDraft): Promise<DraftResult> {
    const adapter = this.adapters.get(accountId);
    if (!adapter) {
      throw new EmailNotFoundError(`account:${accountId}`, accountId);
    }
    return adapter.createDraft(draft);
  }

  /** Connection status for every configured account. */
  getStatuses(): AccountSummary[] {
    return this.getAdapters().map(a => a.getStatus());
  }

  // ---- Internals ----

  private async fanOut(
    op: (adapter: ProviderAdapter) => Promise<NormalizedEmail[]>,
    label: string,
  ): Promise<NormalizedEmail[]> {
    const adapters = this.getAdapters();
    if (adapters.length === 0) {
      mgrLogger.warn(`${label}: no adapters configured`);
      return [];
    }
    // Self-heal: try to (re)connect each account before using it, so an account that
    // dropped since boot rejoins the results instead of being silently skipped. A
    // still-dead account fails fast (connect cooldown) and is isolated per-account.
    const results = await Promise.allSettled(
      adapters.map(async adapter => {
        await adapter.ensureConnected();
        return op(adapter);
      }),
    );
    const all: NormalizedEmail[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        all.push(...r.value);
      } else {
        mgrLogger.warn(`${label}: account ${adapters[i]!.accountId} failed`, {
          error: getErrorMessage(r.reason),
        });
      }
    });
    return sortNewestFirst(all);
  }
}

function sortNewestFirst(emails: NormalizedEmail[]): NormalizedEmail[] {
  return emails.sort((a, b) => {
    const ta = Date.parse(a.date);
    const tb = Date.parse(b.date);
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
  });
}

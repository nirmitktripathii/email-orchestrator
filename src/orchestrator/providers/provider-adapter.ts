/**
 * @module providers/provider-adapter
 * @description Base class + interface for provider adapters.
 *
 * The orchestrator is an MCP *client* to each downstream provider MCP server
 * (Gmail MCP, official Zoho MCP, IMAP MCP for Yahoo). This base class handles
 * the transport plumbing, tool discovery, and result parsing that is common to
 * every provider; subclasses supply provider-specific tool-name defaults and
 * argument/result shaping.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type {
  EmailAccount,
  EmailProvider,
  NormalizedEmail,
  EmailQueryOptions,
  EmailDraft,
  DraftResult,
  ProviderOperation,
  McpConnectionConfig,
  AccountSummary,
} from '../core/types.js';
import { normalizeEmails, normalizeEmail, type RawEmailData } from '../core/email-normalizer.js';
import { ProviderConnectionError, ProviderAuthError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const ORCHESTRATOR_CLIENT_INFO = { name: 'email-orchestrator', version: '1.0.0' } as const;

/** Common interface every provider adapter implements. */
export interface ProviderAdapter {
  readonly accountId: string;
  readonly provider: EmailProvider;
  readonly email: string;
  readonly displayName: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  /**
   * Ensure a live connection, (re)connecting if the child dropped. Safe to call
   * before every operation — it is a no-op when already connected, dedupes
   * concurrent callers, and throttles repeated failures with a cooldown so a
   * dead account never slows the whole fan-out.
   */
  ensureConnected(): Promise<void>;

  listEmails(options?: EmailQueryOptions): Promise<NormalizedEmail[]>;
  getEmail(id: string): Promise<NormalizedEmail | null>;
  searchEmails(query: string, options?: EmailQueryOptions): Promise<NormalizedEmail[]>;
  /** Creates a DRAFT only — the orchestrator never auto-sends on the user's behalf. */
  createDraft(draft: EmailDraft): Promise<DraftResult>;

  getStatus(): AccountSummary;
}

/** Candidate tool names per operation, matched (in order) against discovered tools. */
const DEFAULT_TOOL_CANDIDATES: Record<ProviderOperation, readonly string[]> = {
  listEmails: [
    'list_emails', 'list_messages', 'get_messages', 'list_mail', 'fetch_emails',
    'get_recent_emails', 'list_recent_emails', 'get_unread_emails', 'listEmails', 'get_emails',
  ],
  searchEmails: [
    'search_emails', 'search_messages', 'search_mail', 'query_emails', 'searchEmails', 'search',
  ],
  getEmail: [
    'get_email', 'read_email', 'get_message', 'read_message', 'fetch_email', 'get_mail', 'getEmail',
  ],
  createDraft: [
    'create_draft', 'draft_email', 'save_draft', 'compose_draft', 'createDraft', 'draft', 'compose_email',
  ],
};

/**
 * Base adapter implementing all shared transport / discovery / parsing behavior.
 * Provider subclasses override the small set of protected hooks.
 */
export abstract class BaseMcpAdapter implements ProviderAdapter {
  public readonly accountId: string;
  public readonly provider: EmailProvider;
  public readonly email: string;
  public readonly displayName: string;

  protected readonly connection: McpConnectionConfig;
  protected readonly log: ReturnType<typeof logger.child>;

  private client: Client | null = null;
  private connected = false;
  protected discoveredTools: string[] = [];
  private lastSyncedAt: string | undefined;

  /** In-flight (re)connect, so concurrent callers share one attempt instead of racing. */
  private connectPromise: Promise<void> | null = null;
  /** Bumped on every connect/teardown; stale close handlers from an old socket check it and bail. */
  private connectionGeneration = 0;
  /** Last connect failure, used to cool down retries so a dead account fails fast (see reconnectCooldownMs). */
  private lastConnectError: { at: number; message: string } | null = null;

  /** How many times a single connect attempt retries transient (non-auth) failures. */
  private static readonly CONNECT_RETRIES = 3;
  /** After a failed connect, skip new attempts for this long so one dead account can't stall every fan-out. */
  private static readonly RECONNECT_COOLDOWN_MS = 60_000;
  /** Hard cap on a single connect/handshake so a hung child fails fast instead of blocking forever.
   *  Generous because some servers (Gmail) validate/refresh OAuth on startup (~30s observed). */
  private static readonly CONNECT_TIMEOUT_MS = 60_000;

  constructor(account: EmailAccount) {
    if (!account.connection) {
      throw new ProviderConnectionError(
        account.provider,
        `Account "${account.id}" has no MCP connection configured`,
        { accountId: account.id },
      );
    }
    this.accountId = account.id;
    this.provider = account.provider;
    this.email = account.email;
    this.displayName = account.displayName;
    this.connection = account.connection;
    this.log = logger.child(`adapter:${account.id}`);
  }

  // ---- Provider-specific hooks (overridable) ----

  /** Provider-preferred tool names, tried before the generic candidate list. */
  protected preferredToolNames(): Partial<Record<ProviderOperation, readonly string[]>> {
    return {};
  }

  /** Build the arguments object for a "list emails" call. */
  protected buildListArgs(options: EmailQueryOptions): Record<string, unknown> {
    const args: Record<string, unknown> = {
      maxResults: options.maxResults ?? 25,
      max_results: options.maxResults ?? 25,
      folder: options.folder ?? 'INBOX',
    };
    if (options.unreadOnly) {
      args['unreadOnly'] = true;
      args['query'] = 'is:unread';
    }
    return args;
  }

  /** Build the arguments object for a "search emails" call. */
  protected buildSearchArgs(query: string, options: EmailQueryOptions): Record<string, unknown> {
    return {
      query,
      q: query,
      maxResults: options.maxResults ?? 25,
      max_results: options.maxResults ?? 25,
    };
  }

  /** Build the arguments object for a "get email" call. */
  protected buildGetArgs(id: string): Record<string, unknown> {
    return { id, messageId: id, message_id: id, uid: id };
  }

  /** Build the arguments object for a "create draft" call. */
  protected buildDraftArgs(draft: EmailDraft): Record<string, unknown> {
    return {
      to: draft.to.join(', '),
      cc: draft.cc?.join(', '),
      bcc: draft.bcc?.join(', '),
      subject: draft.subject,
      body: draft.body,
      inReplyTo: draft.inReplyTo,
      threadId: draft.threadId,
    };
  }

  /** Extract an array of raw email objects from an arbitrary parsed tool result. */
  protected extractEmailList(parsed: unknown): RawEmailData[] {
    return coerceEmailArray(parsed);
  }

  /** Extract a single raw email object from an arbitrary parsed tool result. */
  protected extractEmail(parsed: unknown): RawEmailData | null {
    const arr = coerceEmailArray(parsed);
    return arr[0] ?? null;
  }

  // ---- Public API ----

  isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  /** Initial connect. Kept for the boot-time `connectAll`; delegates to the self-healing path. */
  async connect(): Promise<void> {
    await this.ensureConnected();
  }

  async ensureConnected(): Promise<void> {
    if (this.isConnected()) return;
    if (this.connectPromise) return this.connectPromise;

    // Fail fast while cooling down from a recent failure — a dead account must not
    // block the whole cross-account fan-out on every call.
    const err = this.lastConnectError;
    if (err && Date.now() - err.at < BaseMcpAdapter.RECONNECT_COOLDOWN_MS) {
      throw new ProviderConnectionError(
        this.provider,
        `Not reconnecting yet (cooling down after: ${err.message})`,
        { accountId: this.accountId },
      );
    }

    this.connectPromise = (async () => {
      try {
        await this.establishWithRetry();
        await this.afterConnect(); // provider hook (e.g. IMAP re-provisions its account)
        this.lastConnectError = null;
      } catch (e) {
        this.lastConnectError = { at: Date.now(), message: e instanceof Error ? e.message : String(e) };
        throw e;
      }
    })().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    await this.teardown();
    this.lastConnectError = null;
    this.onConnectionLost();
  }

  // ---- Connection internals ----

  /** One connect attempt with bounded retries; auth failures fail fast (retrying won't help). */
  private async establishWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= BaseMcpAdapter.CONNECT_RETRIES; attempt++) {
      try {
        await this.establish();
        if (attempt > 1) this.log.info(`Reconnected to ${this.provider} MCP server on attempt ${attempt}`);
        return;
      } catch (error) {
        lastError = error;
        await this.teardown();
        const message = error instanceof Error ? error.message : String(error);
        if (/unauthor|forbidden|401|403|invalid[_ ]?token|\bauth/i.test(message)) {
          throw new ProviderAuthError(this.provider, `Authentication failed: ${message}`);
        }
        if (/timed out/i.test(message)) {
          // A hung child won't recover by hammering it — fail fast so the cooldown applies.
          throw new ProviderConnectionError(this.provider, `Connect ${message}`, { accountId: this.accountId });
        }
        if (attempt < BaseMcpAdapter.CONNECT_RETRIES) {
          await delay(attempt * 500); // linear backoff: 0.5s, 1s
        }
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new ProviderConnectionError(
      this.provider,
      `Failed to connect after ${BaseMcpAdapter.CONNECT_RETRIES} attempts: ${message}`,
      { accountId: this.accountId },
    );
  }

  /** Build transport + client, handshake, discover tools, and wire drop detection. */
  private async establish(): Promise<void> {
    const transport = this.createTransport();
    const client = new Client(ORCHESTRATOR_CLIENT_INFO, { capabilities: {} });
    const generation = ++this.connectionGeneration;

    await withTimeout(client.connect(transport), BaseMcpAdapter.CONNECT_TIMEOUT_MS, `${this.provider} connect`);
    const { tools } = await withTimeout(client.listTools(), BaseMcpAdapter.CONNECT_TIMEOUT_MS, `${this.provider} listTools`);

    this.discoveredTools = tools.map(t => t.name);
    this.client = client;
    this.connected = true;

    // A dropped child (stdio pipe closes, IMAP idle-timeout, server crash) flips our
    // state to disconnected so the NEXT call transparently reconnects. Without this the
    // old code stayed "connected" forever and every later call threw "Unexpected close".
    const onDrop = (reason?: unknown): void => {
      if (generation !== this.connectionGeneration) return; // superseded by a newer connection
      if (this.connected) {
        this.log.warn(`${this.provider} MCP connection dropped; will reconnect on next use`, {
          reason: reason instanceof Error ? reason.message : reason ? String(reason) : undefined,
        });
      }
      this.connected = false;
      this.client = null;
      this.onConnectionLost();
    };
    client.onclose = () => onDrop();
    client.onerror = (e: Error) => onDrop(e);

    this.log.info(`Connected to ${this.provider} MCP server`, {
      toolCount: this.discoveredTools.length,
      transport: this.connection.transport,
    });
  }

  /** Tear down the current client/transport and invalidate any pending close handlers. */
  private async teardown(): Promise<void> {
    this.connectionGeneration++; // invalidate stale onDrop handlers before we detach
    const client = this.client;
    this.client = null;
    this.connected = false;
    if (client) {
      try {
        await client.close();
      } catch (error) {
        this.log.warn('Error while closing MCP client', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Run a downstream call, self-healing across a mid-flight connection drop: ensure
   * connected, and if the call fails because the child died, reconnect once and retry.
   * Read operations are idempotent, so a single retry is safe.
   */
  private async withConnection<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureConnected();
    try {
      return await fn();
    } catch (error) {
      if (!isConnectionDrop(error)) throw error;
      this.log.warn(`${this.provider} call hit a dropped connection; reconnecting and retrying once`, {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.teardown();
      this.onConnectionLost();
      await this.ensureConnected();
      return await fn();
    }
  }

  // ---- Provider reconnection hooks (overridable) ----

  /** Called after every successful (re)connect. Providers that hold per-connection
   *  server-side state (e.g. IMAP account provisioning) re-establish it here. */
  protected async afterConnect(): Promise<void> {
    /* default: nothing */
  }

  /** Called whenever the connection is lost or torn down. Providers reset any
   *  per-connection caches so the next connect rebuilds them. */
  protected onConnectionLost(): void {
    /* default: nothing */
  }

  async listEmails(options: EmailQueryOptions = {}): Promise<NormalizedEmail[]> {
    const parsed = await this.callOperation('listEmails', this.buildListArgs(options));
    const raws = this.extractEmailList(parsed);
    const emails = normalizeEmails(raws, this.provider, this.accountId, this.email);
    this.lastSyncedAt = new Date().toISOString();
    return applyClientSideFilters(emails, options);
  }

  async searchEmails(query: string, options: EmailQueryOptions = {}): Promise<NormalizedEmail[]> {
    const parsed = await this.callOperation('searchEmails', this.buildSearchArgs(query, options));
    const raws = this.extractEmailList(parsed);
    const emails = normalizeEmails(raws, this.provider, this.accountId, this.email);
    this.lastSyncedAt = new Date().toISOString();
    return applyClientSideFilters(emails, options);
  }

  async getEmail(id: string): Promise<NormalizedEmail | null> {
    const parsed = await this.callOperation('getEmail', this.buildGetArgs(id));
    const raw = this.extractEmail(parsed);
    if (!raw) return null;
    try {
      return normalizeEmail(raw, this.provider, this.accountId, this.email);
    } catch {
      return null;
    }
  }

  async createDraft(draft: EmailDraft): Promise<DraftResult> {
    const parsed = await this.callOperation('createDraft', this.buildDraftArgs(draft));
    const draftId = extractDraftId(parsed) ?? `draft-${Date.now()}`;
    this.log.info('Draft created', { draftId });
    return { draftId, accountId: this.accountId, provider: this.provider };
  }

  getStatus(): AccountSummary {
    return {
      accountId: this.accountId,
      accountEmail: this.email,
      provider: this.provider,
      totalEmails: 0,
      unreadCount: 0,
      isConnected: this.connected,
      ...(this.lastSyncedAt ? { lastSyncedAt: this.lastSyncedAt } : {}),
    };
  }

  // ---- Internals ----

  /** Resolve a logical operation to a concrete downstream tool name. */
  protected resolveToolName(operation: ProviderOperation): string {
    // 1. explicit override from config
    const override = this.connection.toolMap?.[operation];
    if (override && this.discoveredTools.includes(override)) return override;

    // 2. provider-preferred names
    const preferred = this.preferredToolNames()[operation] ?? [];
    for (const name of preferred) {
      if (this.discoveredTools.includes(name)) return name;
    }

    // 3. generic candidates (exact)
    for (const name of DEFAULT_TOOL_CANDIDATES[operation]) {
      if (this.discoveredTools.includes(name)) return name;
    }

    // 4. fuzzy — first discovered tool whose name contains a candidate fragment
    const fragments = [...preferred, ...DEFAULT_TOOL_CANDIDATES[operation]].map(n =>
      n.replace(/[_-]/g, '').toLowerCase(),
    );
    for (const discovered of this.discoveredTools) {
      const flat = discovered.replace(/[_-]/g, '').toLowerCase();
      if (fragments.some(f => flat.includes(f) || f.includes(flat))) return discovered;
    }

    throw new ProviderConnectionError(
      this.provider,
      `No downstream tool found for operation "${operation}". ` +
        `Discovered tools: [${this.discoveredTools.join(', ')}]. ` +
        `Set a toolMap override in this account's connection config.`,
      { operation, discoveredTools: this.discoveredTools },
    );
  }

  /** Call a resolved tool, dropping undefined args, and return the parsed result. */
  protected async callOperation(
    operation: ProviderOperation,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const cleanArgs = dropUndefined(args);
    return this.withConnection(async () => {
      // Resolve inside withConnection: a reconnect re-discovers tools, and resolution
      // depends on this.discoveredTools being populated by the current connection.
      const toolName = this.resolveToolName(operation);
      this.log.debug('Calling downstream tool', { operation, toolName });
      const result = await this.client!.callTool({ name: toolName, arguments: cleanArgs });

      if ((result as { isError?: boolean }).isError) {
        const text = extractText(result);
        throw new ProviderConnectionError(this.provider, `Downstream tool "${toolName}" failed: ${text}`, {
          operation,
          toolName,
        });
      }
      return parseToolResult(result);
    });
  }

  /**
   * Call a downstream tool by its exact name (bypassing operation resolution)
   * and return the parsed result. Used by provider subclasses that need
   * auxiliary calls — e.g. Zoho fetching its accountId / folder list.
   */
  protected async callToolRaw(name: string, args: Record<string, unknown>): Promise<unknown> {
    const cleanArgs = dropUndefined(args);
    return this.withConnection(async () => {
      const result = await this.client!.callTool({ name, arguments: cleanArgs });
      if ((result as { isError?: boolean }).isError) {
        const text = extractText(result);
        throw new ProviderConnectionError(this.provider, `Downstream tool "${name}" failed: ${text}`, {
          toolName: name,
        });
      }
      return parseToolResult(result);
    });
  }

  /** Build the client transport from connection config. Protected so tests can
   *  inject an in-memory transport in place of a real child process. */
  protected createTransport(): Transport {
    const c = this.connection;
    switch (c.transport) {
      case 'stdio': {
        if (!c.command) {
          throw new ProviderConnectionError(this.provider, 'stdio transport requires a command');
        }
        return new StdioClientTransport({
          command: c.command,
          args: [...(c.args ?? [])],
          env: buildStdioEnv(c.env),
        });
      }
      case 'sse': {
        if (!c.url) throw new ProviderConnectionError(this.provider, 'sse transport requires a url');
        return new SSEClientTransport(new URL(c.url), {
          ...(c.headers ? { requestInit: { headers: { ...c.headers } } } : {}),
          ...(c.headers ? { eventSourceInit: { fetch: withHeaders(c.headers) } } : {}),
        });
      }
      case 'http': {
        if (!c.url) throw new ProviderConnectionError(this.provider, 'http transport requires a url');
        return new StreamableHTTPClientTransport(new URL(c.url), {
          ...(c.headers ? { requestInit: { headers: { ...c.headers } } } : {}),
        });
      }
      default:
        throw new ProviderConnectionError(this.provider, `Unknown transport: ${String(c.transport)}`);
    }
  }
}

// ============================
// Free-standing helpers
// ============================

/** Resolve after `ms` milliseconds (connect backoff). */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Reject with a "timed out" error if `p` doesn't settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

/**
 * True when an error means the underlying MCP connection died (as opposed to a
 * normal tool-level failure). These are the cases a reconnect-and-retry can fix.
 * Covers the MCP SDK's "Connection closed"/"Unexpected close" and the raw socket
 * errors an stdio child surfaces when it exits mid-request.
 */
function isConnectionDrop(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    /unexpected close|connection closed|closed unexpectedly|not connected|transport (is )?closed/.test(message) ||
    /econnreset|epipe|broken pipe|socket hang up|write after end|terminated|premature close|stream closed/.test(message)
  );
}

/**
 * Inherit the full parent environment for stdio children, then overlay adapter
 * overrides. Inheriting everything (rather than a whitelist) matters because child
 * MCP servers frequently depend on TLS/proxy variables — e.g. NODE_EXTRA_CA_CERTS /
 * SSL_CERT_FILE / NODE_USE_SYSTEM_CA when antivirus or a corporate proxy performs
 * HTTPS inspection. Stripping those breaks the child's outbound HTTPS calls even
 * though the parent's work.
 */
function buildStdioEnv(custom?: Readonly<Record<string, string>>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') base[key] = value;
  }
  return { ...base, ...(custom ?? {}) };
}

/** Wrap fetch so EventSource-style requests carry auth headers (SSE transport). */
function withHeaders(headers: Readonly<Record<string, string>>): typeof fetch {
  return ((input, init) =>
    fetch(input, { ...init, headers: { ...(init?.headers ?? {}), ...headers } })) as typeof fetch;
}

/** Remove keys whose value is undefined (keeps downstream schemas happy). */
function dropUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Concatenate all text content blocks from a callTool result. */
function extractText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } =>
      typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text',
    )
    .map(b => b.text)
    .join('\n');
}

/**
 * Parse an MCP callTool result into structured data.
 * Prefers structuredContent; otherwise parses JSON out of text blocks; otherwise
 * returns the raw text.
 */
export function parseToolResult(result: unknown): unknown {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured !== undefined && structured !== null) return structured;

  const text = extractText(result);
  if (!text) return null;

  const direct = tryParseJson(text);
  if (direct !== undefined) return direct;

  // Try to salvage an embedded JSON array/object from human-readable text.
  const embedded = extractEmbeddedJson(text);
  if (embedded !== undefined) return embedded;

  return text;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

function extractEmbeddedJson(text: string): unknown {
  const firstArr = text.indexOf('[');
  const firstObj = text.indexOf('{');
  const start = firstArr === -1 ? firstObj : firstObj === -1 ? firstArr : Math.min(firstArr, firstObj);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  const end = text.lastIndexOf(close);
  if (end <= start) return undefined;
  return tryParseJson(text.slice(start, end + 1));
}

/** Coerce many possible shapes into an array of email-like objects. */
export function coerceEmailArray(parsed: unknown): RawEmailData[] {
  if (parsed === null || parsed === undefined) return [];
  if (Array.isArray(parsed)) {
    return parsed.filter((x): x is RawEmailData => typeof x === 'object' && x !== null);
  }
  if (typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    // Common envelope keys: { emails: [...] } / { messages: [...] } / { data: [...] }
    for (const key of ['emails', 'messages', 'items', 'data', 'results', 'value']) {
      const inner = obj[key];
      if (Array.isArray(inner)) {
        return inner.filter((x): x is RawEmailData => typeof x === 'object' && x !== null);
      }
    }
    // A single email object
    if ('id' in obj || 'messageId' in obj || 'uid' in obj || 'subject' in obj) {
      return [obj];
    }
  }
  return [];
}

/** Best-effort extraction of a created draft's id from a tool result. */
function extractDraftId(parsed: unknown): string | undefined {
  if (typeof parsed === 'string') {
    const match = parsed.match(/([A-Za-z0-9_-]{6,})/);
    return match?.[1];
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of ['draftId', 'id', 'messageId', 'draft_id']) {
      const value = obj[key];
      if (typeof value === 'string' && value) return value;
    }
    const nested = obj['draft'];
    if (nested && typeof nested === 'object') {
      const id = (nested as Record<string, unknown>)['id'];
      if (typeof id === 'string') return id;
    }
  }
  return undefined;
}

/** Apply filters the downstream server may not have honored (unread/since). */
function applyClientSideFilters(
  emails: NormalizedEmail[],
  options: EmailQueryOptions,
): NormalizedEmail[] {
  let out = emails;
  if (options.unreadOnly) {
    out = out.filter(e => !e.isRead);
  }
  if (options.since) {
    const cutoff = Date.parse(options.since);
    if (!Number.isNaN(cutoff)) {
      out = out.filter(e => {
        const t = Date.parse(e.date);
        return Number.isNaN(t) ? true : t >= cutoff;
      });
    }
  }
  if (options.maxResults && out.length > options.maxResults) {
    out = out.slice(0, options.maxResults);
  }
  return out;
}

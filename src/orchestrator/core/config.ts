/**
 * @module core/config
 * @description Configuration loader for the Email AI Agent.
 * Reads from environment variables (.env file) and provides typed configuration.
 */

import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import type {
  AppConfig, EmailAccount, LLMConfig, ScheduleConfig, NotificationConfig, CacheConfig,
  McpConnectionConfig, McpTransportType,
} from './types.js';
import { ConfigError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const configLogger = logger.child('config');

/**
 * Find the project root by walking up from a starting directory until a
 * package.json is found. This works both in dev (source files under
 * src/orchestrator/...) and in production (bundled into dist/index.js), where a
 * fixed relative depth would be wrong.
 */
function findProjectRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = findProjectRoot(__dirname);

// Load .env: prefer an explicit ENV_FILE, else the project-root .env, else cwd/.env.
const envPath = process.env['ENV_FILE'] ?? resolve(projectRoot, '.env');
loadDotenv({ path: envPath });
if (!existsSync(envPath)) {
  loadDotenv(); // fall back to default (cwd/.env) — harmless if absent
}

/**
 * Safely read an environment variable with optional default.
 */
function env(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value !== undefined && value !== '') return value;
  if (defaultValue !== undefined) return defaultValue;
  throw new ConfigError(`Missing required environment variable: ${key}`);
}

/**
 * Read an optional environment variable.
 */
function envOptional(key: string): string | undefined {
  const value = process.env[key];
  return value !== undefined && value !== '' ? value : undefined;
}

/** Cross-platform default launcher for npx-based stdio MCP servers. */
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const requireFromHere = createRequire(import.meta.url);

/**
 * Resolve an installed package's runnable entry file (bin or main) so it can be
 * launched with `node <entry>` directly. This avoids the `npx.cmd` batch wrapper,
 * which on Windows + Node 22 either fails to spawn (EINVAL on `.cmd`) or fails to
 * forward stdin to the child MCP server (breaking the stdio handshake).
 */
function resolvePackageEntry(pkg: string): string | undefined {
  try {
    const pkgJsonPath = requireFromHere.resolve(`${pkg}/package.json`);
    const pkgDir = dirname(pkgJsonPath);
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { bin?: unknown; main?: unknown };
    let rel: string | undefined;
    if (typeof pkgJson.bin === 'string') rel = pkgJson.bin;
    else if (pkgJson.bin && typeof pkgJson.bin === 'object') {
      const first = Object.values(pkgJson.bin as Record<string, unknown>)[0];
      if (typeof first === 'string') rel = first;
    }
    if (!rel && typeof pkgJson.main === 'string') rel = pkgJson.main;
    if (!rel) return undefined;
    const entry = resolve(pkgDir, rel);
    return existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a stdio connection for a provider MCP server, preferring a direct-Node
 * launch of the locally-installed package and falling back to npx.
 */
function buildStdioLauncher(
  pkg: string,
  commandEnvKey: string,
  argsEnvKey: string,
  childEnv?: Record<string, string>,
): McpConnectionConfig {
  const commandOverride = envOptional(commandEnvKey);
  if (commandOverride) {
    return {
      transport: 'stdio',
      command: commandOverride,
      args: parseArgsEnv(argsEnvKey, []),
      ...(childEnv ? { env: childEnv } : {}),
    };
  }
  const entry = resolvePackageEntry(pkg);
  if (entry) {
    // process.execPath is the absolute node binary running the orchestrator.
    return {
      transport: 'stdio',
      command: process.execPath,
      args: [entry],
      ...(childEnv ? { env: childEnv } : {}),
    };
  }
  // Fallback: npx (reliable on macOS/Linux; may be flaky on Windows).
  return {
    transport: 'stdio',
    command: NPX,
    args: parseArgsEnv(argsEnvKey, ['-y', pkg]),
    ...(childEnv ? { env: childEnv } : {}),
  };
}

/**
 * Parse an args list from an env var. Accepts a JSON array (`["-y","pkg"]`) or a
 * plain space-separated string; falls back to the provided default.
 */
function parseArgsEnv(key: string, defaultArgs: readonly string[]): string[] {
  const raw = envOptional(key);
  if (!raw) return [...defaultArgs];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      configLogger.warn(`Could not parse ${key} as JSON array; falling back to whitespace split`);
    }
  }
  return trimmed.split(/\s+/);
}

/** Build the stdio connection for the Gmail MCP server. */
function buildGmailConnection(): McpConnectionConfig {
  return buildStdioLauncher(
    '@gongrzhe/server-gmail-autoauth-mcp',
    'GMAIL_MCP_COMMAND',
    'GMAIL_MCP_ARGS',
  );
}

/** Build the remote connection for the official hosted Zoho Mail MCP server. */
function buildZohoConnection(): McpConnectionConfig | undefined {
  const url = envOptional('ZOHO_MCP_URL');
  if (!url) {
    configLogger.warn('ZOHO_MCP_URL not set — Zoho account will be configured but not wired to an MCP server');
    return undefined;
  }
  const transport = (envOptional('ZOHO_MCP_TRANSPORT') ?? 'sse') as McpTransportType;
  const token = envOptional('ZOHO_MCP_AUTH_TOKEN');
  // Zoho's mailbox accountId (a long numeric zoid, distinct from the org id in the
  // server URL). Optional — the adapter auto-detects it via getMailAccounts if unset.
  const accountId = envOptional('ZOHO_MAIL_ACCOUNT_ID');
  return {
    transport,
    url,
    ...(accountId ? { accountId } : {}),
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  };
}

/**
 * Read-only allowlist for imap-mcp-server. Only these tools are registered in the
 * child, so no send/delete/move/flag tool ever exists for the agent to reach — a
 * hard, server-enforced backstop for the never-send invariant (the ImapAdapter
 * also refuses to draft). `imap_add_account` is included because the adapter
 * provisions its account at runtime; it only stores a read credential, never sends.
 */
const IMAP_READONLY_TOOLS =
  'imap_list_accounts,imap_add_account,imap_get_latest_emails,imap_search_emails,imap_get_email';

/**
 * Overlay the read-only tool allowlist and, when explicitly opted in, a local-only
 * TLS bypass. `IMAP_ALLOW_INSECURE_TLS` sets NODE_TLS_REJECT_UNAUTHORIZED=0 on the
 * IMAP child ONLY — a workaround for local antivirus (e.g. Avast Mail Shield)
 * intercepting port 993 with its own CA. It is OFF by default, so real deployments
 * (the Macs) keep full certificate validation. Never enable it in production.
 */
function withImapGuards(childEnv: Record<string, string>): Record<string, string> {
  const guarded: Record<string, string> = { ...childEnv, IMAP_MCP_ENABLED_TOOLS: IMAP_READONLY_TOOLS };
  const insecure = (envOptional('IMAP_ALLOW_INSECURE_TLS') ?? '').toLowerCase();
  if (insecure === '1' || insecure === 'true' || insecure === 'yes' || insecure === 'on') {
    guarded['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    configLogger.warn(
      'IMAP_ALLOW_INSECURE_TLS is set — disabling TLS certificate validation for the IMAP ' +
        'child process. Use this ONLY for local antivirus interception; never in production.',
    );
  }
  return guarded;
}

/** Build the stdio connection for the IMAP MCP server (Yahoo via app password). */
function buildImapConnection(): McpConnectionConfig {
  // Credentials are read by the ImapAdapter from these env keys (imap-mcp-server
  // itself ignores env creds — the adapter provisions the account via a tool call).
  const emailAddr = envOptional('YAHOO_EMAIL') ?? '';
  const password = envOptional('YAHOO_APP_PASSWORD') ?? '';
  const host = envOptional('YAHOO_IMAP_HOST') ?? 'imap.mail.yahoo.com';
  const port = envOptional('YAHOO_IMAP_PORT') ?? '993';
  const smtpHost = envOptional('YAHOO_SMTP_HOST') ?? 'smtp.mail.yahoo.com';
  const smtpPort = envOptional('YAHOO_SMTP_PORT') ?? '465';

  const childEnv: Record<string, string> = withImapGuards({
    IMAP_HOST: host, IMAP_PORT: port, IMAP_USER: emailAddr, IMAP_PASSWORD: password, IMAP_TLS: 'true',
    EMAIL_HOST: host, EMAIL_PORT: port, EMAIL_USER: emailAddr, EMAIL_PASSWORD: password,
    SMTP_HOST: smtpHost, SMTP_PORT: smtpPort, SMTP_USER: emailAddr, SMTP_PASSWORD: password,
  });

  return buildStdioLauncher('imap-mcp-server', 'YAHOO_MCP_COMMAND', 'YAHOO_MCP_ARGS', childEnv);
}

/** Parse an optional JSON tool-name map (`{"listEmails":"list-messages",...}`). */
function parseToolMap(key: string): Readonly<Partial<Record<string, string>>> | undefined {
  const raw = envOptional(key);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
  } catch {
    configLogger.warn(`Could not parse ${key} as a JSON object; ignoring it.`);
  }
  return undefined;
}

/**
 * Build the connection to an OAuth-based Microsoft Graph MCP server, used for
 * Microsoft 365 work/school accounts whose tenant disables IMAP basic-auth.
 * Returns undefined when no Graph MCP is configured (the caller falls back to IMAP).
 *
 * Wiring (see docs/OUTLOOK-GRAPH-SETUP.md):
 *   OUTLOOK_GRAPH_MCP_URL      → remote Graph MCP endpoint (http/sse), OR
 *   OUTLOOK_GRAPH_MCP_COMMAND  → local stdio Graph MCP (+ OUTLOOK_GRAPH_MCP_ARGS)
 *   OUTLOOK_GRAPH_AUTH_TOKEN   → optional bearer for a remote endpoint
 *   OUTLOOK_GRAPH_TOOLMAP      → optional JSON mapping logical ops → that server's tool names
 */
function buildOutlookGraphConnection(): McpConnectionConfig | undefined {
  const url = envOptional('OUTLOOK_GRAPH_MCP_URL');
  const command = envOptional('OUTLOOK_GRAPH_MCP_COMMAND');
  if (!url && !command) return undefined;

  const toolMap = parseToolMap('OUTLOOK_GRAPH_TOOLMAP') as
    | Readonly<Partial<Record<import('./types.js').ProviderOperation, string>>>
    | undefined;

  if (url) {
    const transport = (envOptional('OUTLOOK_GRAPH_MCP_TRANSPORT') ?? 'http') as McpTransportType;
    const token = envOptional('OUTLOOK_GRAPH_AUTH_TOKEN');
    return {
      transport,
      url,
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      ...(toolMap ? { toolMap } : {}),
    };
  }
  // Local stdio Graph MCP server.
  return {
    transport: 'stdio',
    command: command!,
    args: parseArgsEnv('OUTLOOK_GRAPH_MCP_ARGS', []),
    ...(toolMap ? { toolMap } : {}),
  };
}

/**
 * Build the stdio connection for Outlook via IMAP. Works for personal Outlook.com /
 * Hotmail with an app password (2FA required). NOTE: many Microsoft 365 work/school
 * accounts have IMAP basic-auth disabled by org policy — set the OUTLOOK_GRAPH_MCP_*
 * vars to use the OAuth Microsoft Graph path instead (see docs/OUTLOOK-GRAPH-SETUP.md).
 */
function buildOutlookConnection(): McpConnectionConfig {
  // Prefer the OAuth Graph path when it's configured (needed for locked-down M365).
  const graph = buildOutlookGraphConnection();
  if (graph) {
    configLogger.info('Outlook: using Microsoft Graph MCP (OAuth) connection');
    return graph;
  }

  const emailAddr = envOptional('OUTLOOK_EMAIL') ?? '';
  const password = envOptional('OUTLOOK_APP_PASSWORD') ?? '';
  const host = envOptional('OUTLOOK_IMAP_HOST') ?? 'outlook.office365.com';
  const port = envOptional('OUTLOOK_IMAP_PORT') ?? '993';
  const smtpHost = envOptional('OUTLOOK_SMTP_HOST') ?? 'smtp-mail.outlook.com';
  const smtpPort = envOptional('OUTLOOK_SMTP_PORT') ?? '587';

  const childEnv: Record<string, string> = withImapGuards({
    IMAP_HOST: host, IMAP_PORT: port, IMAP_USER: emailAddr, IMAP_PASSWORD: password, IMAP_TLS: 'true',
    EMAIL_HOST: host, EMAIL_PORT: port, EMAIL_USER: emailAddr, EMAIL_PASSWORD: password,
    SMTP_HOST: smtpHost, SMTP_PORT: smtpPort, SMTP_USER: emailAddr, SMTP_PASSWORD: password,
  });

  return buildStdioLauncher('imap-mcp-server', 'OUTLOOK_MCP_COMMAND', 'OUTLOOK_MCP_ARGS', childEnv);
}

/**
 * Parse LLM configuration from environment variables.
 */
function parseLLMConfig(): LLMConfig {
  const provider = env('LLM_PROVIDER', 'gemini') as LLMConfig['provider'];
  const validProviders = ['gemini', 'openai', 'anthropic', 'groq', 'ollama', 'custom'];
  if (!validProviders.includes(provider)) {
    throw new ConfigError(`Invalid LLM_PROVIDER: ${provider}. Must be one of: ${validProviders.join(', ')}`);
  }

  return {
    provider,
    model: env('LLM_MODEL', 'gemma-3-27b-it'),
    apiKey: env('LLM_API_KEY', ''),
    baseUrl: envOptional('LLM_BASE_URL'),
    maxTokens: parseInt(env('LLM_MAX_TOKENS', '4096'), 10),
    temperature: parseFloat(env('LLM_TEMPERATURE', '0.3')),
  };
}

/**
 * Parse email accounts from environment variables.
 * Accounts are defined as ACCOUNT_<N>_<FIELD> env vars.
 */
function parseEmailAccounts(): EmailAccount[] {
  const accounts: EmailAccount[] = [];

  // Parse Gmail accounts
  if (envOptional('GMAIL_CLIENT_ID') || envOptional('GMAIL_EMAIL')) {
    accounts.push({
      id: env('GMAIL_ACCOUNT_ID', 'gmail-primary'),
      provider: 'gmail',
      email: env('GMAIL_EMAIL', ''),
      displayName: env('GMAIL_DISPLAY_NAME', 'Gmail'),
      isActive: true,
      mcpServerName: env('GMAIL_MCP_SERVER', 'gmail'),
      connection: buildGmailConnection(),
    });
  }

  // Parse Zoho accounts
  if (envOptional('ZOHO_MCP_URL') || envOptional('ZOHO_CLIENT_ID') || envOptional('ZOHO_EMAIL')) {
    const zohoConnection = buildZohoConnection();
    accounts.push({
      id: env('ZOHO_ACCOUNT_ID', 'zoho-primary'),
      provider: 'zoho',
      email: env('ZOHO_EMAIL', ''),
      displayName: env('ZOHO_DISPLAY_NAME', 'Zoho Mail'),
      isActive: true,
      mcpServerName: env('ZOHO_MCP_SERVER', 'zoho-mail'),
      ...(zohoConnection ? { connection: zohoConnection } : {}),
    });
  }

  // Parse Yahoo accounts
  if (envOptional('YAHOO_EMAIL')) {
    accounts.push({
      id: env('YAHOO_ACCOUNT_ID', 'yahoo-primary'),
      provider: 'yahoo',
      email: env('YAHOO_EMAIL', ''),
      displayName: env('YAHOO_DISPLAY_NAME', 'Yahoo Mail'),
      isActive: true,
      mcpServerName: env('YAHOO_MCP_SERVER', 'yahoo-mail'),
      connection: buildImapConnection(),
    });
  }

  // Parse Outlook accounts (via IMAP)
  if (envOptional('OUTLOOK_EMAIL')) {
    accounts.push({
      id: env('OUTLOOK_ACCOUNT_ID', 'outlook-primary'),
      provider: 'outlook',
      email: env('OUTLOOK_EMAIL', ''),
      displayName: env('OUTLOOK_DISPLAY_NAME', 'Outlook'),
      isActive: true,
      mcpServerName: env('OUTLOOK_MCP_SERVER', 'outlook-mail'),
      connection: buildOutlookConnection(),
    });
  }

  configLogger.info(`Parsed ${accounts.length} email accounts`, {
    accounts: accounts.map(a => ({ id: a.id, provider: a.provider, email: a.email })),
  });

  return accounts;
}

/**
 * Parse schedule configuration.
 */
function parseScheduleConfig(): ScheduleConfig {
  const timesStr = env('DIGEST_SCHEDULE', '09:00');
  const times = timesStr.split(',').map(t => t.trim()).filter(t => /^\d{2}:\d{2}$/.test(t));

  if (times.length > 3) {
    throw new ConfigError('Maximum 3 scheduled digest times per day allowed');
  }

  return {
    enabled: times.length > 0,
    times,
    timezone: env('TIMEZONE', 'Asia/Kolkata'),
    maxTimesPerDay: 3,
  };
}

/**
 * Parse notification configuration.
 */
function parseNotificationConfig(): NotificationConfig {
  return {
    enabled: env('NOTIFICATIONS_ENABLED', 'true') === 'true',
    sound: env('NOTIFICATIONS_SOUND', 'true') === 'true',
    urgentOnly: env('NOTIFICATIONS_URGENT_ONLY', 'false') === 'true',
  };
}

/**
 * Parse cache configuration.
 */
function parseCacheConfig(): CacheConfig {
  return {
    enabled: env('CACHE_ENABLED', 'true') === 'true',
    ttlSeconds: parseInt(env('CACHE_TTL', '300'), 10),
    maxEntries: parseInt(env('CACHE_MAX_ENTRIES', '1000'), 10),
  };
}

/**
 * Load and validate the complete application configuration.
 */
export function loadConfig(): AppConfig {
  configLogger.info('Loading application configuration...');

  const config: AppConfig = {
    llm: parseLLMConfig(),
    accounts: parseEmailAccounts(),
    schedule: parseScheduleConfig(),
    notifications: parseNotificationConfig(),
    cache: parseCacheConfig(),
    logLevel: env('LOG_LEVEL', 'info') as AppConfig['logLevel'],
  };

  configLogger.info('Configuration loaded successfully', {
    llmProvider: config.llm.provider,
    llmModel: config.llm.model,
    accountCount: config.accounts.length,
    scheduleEnabled: config.schedule.enabled,
    scheduleTimes: config.schedule.times,
    notificationsEnabled: config.notifications.enabled,
  });

  return config;
}

/**
 * Validate that all required configuration for the orchestrator is present.
 * Returns list of missing/invalid config items.
 */
export function validateConfig(config: AppConfig): string[] {
  const issues: string[] = [];

  if (!config.llm.apiKey) {
    issues.push('LLM_API_KEY is not set — AI features will not work');
  }

  if (config.accounts.length === 0) {
    issues.push('No email accounts configured — configure at least one provider');
  }

  for (const account of config.accounts) {
    if (!account.email) {
      issues.push(`Account ${account.id}: email address is not set`);
    }
  }

  if (config.schedule.times.length > config.schedule.maxTimesPerDay) {
    issues.push(`Schedule: maximum ${config.schedule.maxTimesPerDay} digest times per day`);
  }

  return issues;
}

/** Get project root path */
export function getProjectRoot(): string {
  return projectRoot;
}

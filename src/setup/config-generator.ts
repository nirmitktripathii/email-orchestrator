#!/usr/bin/env node
/**
 * @module setup/config-generator
 * @description Generates an MCP client config (Claude Desktop + Antigravity) that
 * launches the built email-orchestrator server with the environment from your .env.
 * Run with: npm run generate-config
 *
 * In this architecture the orchestrator is the single MCP server the client talks to;
 * it connects to the Gmail/Zoho/IMAP MCP servers itself. So the generated config only
 * needs the orchestrator entry.
 */

import { resolve } from 'path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { homedir, platform } from 'os';
import { stdout } from 'node:process';
import { parseEnvFile, findProjectRoot } from './env-file.js';

/** Env keys the orchestrator process needs, forwarded into the client config. */
const FORWARDED_ENV_KEYS = [
  'LLM_PROVIDER', 'LLM_MODEL', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MAX_TOKENS', 'LLM_TEMPERATURE',
  'GMAIL_EMAIL', 'GMAIL_DISPLAY_NAME', 'GMAIL_ACCOUNT_ID', 'GMAIL_CLIENT_ID', 'GMAIL_MCP_COMMAND', 'GMAIL_MCP_ARGS',
  'ZOHO_EMAIL', 'ZOHO_DISPLAY_NAME', 'ZOHO_ACCOUNT_ID', 'ZOHO_MAIL_ACCOUNT_ID', 'ZOHO_REGION', 'ZOHO_MCP_URL', 'ZOHO_MCP_TRANSPORT', 'ZOHO_MCP_AUTH_TOKEN',
  'YAHOO_EMAIL', 'YAHOO_APP_PASSWORD', 'YAHOO_DISPLAY_NAME', 'YAHOO_IMAP_HOST', 'YAHOO_IMAP_PORT', 'YAHOO_SMTP_HOST', 'YAHOO_SMTP_PORT',
  'YAHOO_MCP_COMMAND', 'YAHOO_MCP_ARGS',
  'OUTLOOK_EMAIL', 'OUTLOOK_APP_PASSWORD', 'OUTLOOK_DISPLAY_NAME', 'OUTLOOK_ACCOUNT_ID', 'OUTLOOK_IMAP_HOST', 'OUTLOOK_IMAP_PORT',
  'OUTLOOK_SMTP_HOST', 'OUTLOOK_SMTP_PORT', 'OUTLOOK_MCP_COMMAND', 'OUTLOOK_MCP_ARGS',
  'NOTIFICATIONS_ENABLED', 'NOTIFICATIONS_SOUND', 'NOTIFICATIONS_URGENT_ONLY',
  'DIGEST_SCHEDULE', 'TIMEZONE', 'URGENT_POLL_MINUTES', 'LOG_LEVEL', 'CACHE_TTL',
] as const;

function clientConfigPath(): { label: string; path: string } {
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return { label: 'Claude Desktop (Windows)', path: resolve(process.env['APPDATA'] ?? resolve(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json') };
    case 'darwin':
      return { label: 'Claude Desktop (macOS)', path: resolve(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') };
    default:
      return { label: 'Claude Desktop (Linux)', path: resolve(home, '.config', 'Claude', 'claude_desktop_config.json') };
  }
}

function main(): void {
  const projectRoot = findProjectRoot();
  const envPath = resolve(projectRoot, '.env');
  const env = parseEnvFile(envPath);
  const entry = resolve(projectRoot, 'dist', 'index.js');

  if (!existsSync(entry)) {
    stdout.write(`⚠️  ${entry} not found — run "npm run build" first.\n`);
  }

  const forwardedEnv: Record<string, string> = {};
  for (const key of FORWARDED_ENV_KEYS) {
    if (env[key]) forwardedEnv[key] = env[key]!;
  }

  // Forward TLS / proxy variables from the CURRENT environment so the launched
  // orchestrator (and the child MCP servers it spawns) trust the same CA chain.
  // Essential when antivirus/corporate proxies perform HTTPS inspection (e.g. Avast's
  // NODE_EXTRA_CA_CERTS) — without these, outbound HTTPS from the servers fails with
  // "unable to verify the first certificate".
  const SYSTEM_PASSTHROUGH = [
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'NODE_USE_SYSTEM_CA', 'NODE_OPTIONS',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  ];
  for (const key of SYSTEM_PASSTHROUGH) {
    const value = process.env[key];
    if (value) forwardedEnv[key] = value;
  }

  // Ensure the orchestrator can find its .env even if launched from elsewhere.
  forwardedEnv['ENV_FILE'] = envPath;

  const orchestratorEntry = {
    command: process.execPath, // absolute node path for reliability
    args: [entry],
    env: forwardedEnv,
  };
  const mcpServers = { 'email-orchestrator': orchestratorEntry };

  const claudeConfig = { mcpServers };
  // Antigravity uses the same mcpServers shape.
  const antigravityConfig = { mcpServers };

  const outDir = resolve(projectRoot, 'config', 'generated');
  mkdirSync(outDir, { recursive: true });
  const claudeOut = resolve(outDir, 'claude_desktop_config.json');
  const antigravityOut = resolve(outDir, 'antigravity_mcp_config.json');
  writeFileSync(claudeOut, JSON.stringify(claudeConfig, null, 2) + '\n', 'utf-8');
  writeFileSync(antigravityOut, JSON.stringify(antigravityConfig, null, 2) + '\n', 'utf-8');

  const target = clientConfigPath();
  stdout.write('\n✅ Generated MCP client configs:\n');
  stdout.write(`   • ${claudeOut}\n`);
  stdout.write(`   • ${antigravityOut}\n\n`);

  // `--install` merges the orchestrator entry straight into the live Claude Desktop
  // config, preserving any other MCP servers and settings already there (with a
  // timestamped backup). This is what the macOS installer calls so non-technical
  // users never hand-edit JSON.
  if (process.argv.includes('--install')) {
    installIntoClaudeDesktop(target.path, orchestratorEntry);
  } else {
    stdout.write('To install for Claude Desktop, merge the "email-orchestrator" entry into:\n');
    stdout.write(`   ${target.path}\n`);
    stdout.write('   (create the file if it does not exist), then fully restart Claude Desktop.\n');
    stdout.write('   Or re-run with --install to merge it automatically.\n\n');
    stdout.write('For Antigravity, add the same mcpServers entry to its MCP configuration.\n');
  }

  if (Object.keys(forwardedEnv).length <= 1) {
    stdout.write('\n⚠️  No provider/LLM values found in .env — run "npm run setup" first.\n');
  }
}

/** Shape of the bits of the Claude Desktop config we touch. */
interface ClaudeDesktopConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Merge the orchestrator entry into the live Claude Desktop config in place,
 * preserving every other key and MCP server. Backs up the current file first.
 */
function installIntoClaudeDesktop(targetPath: string, orchestratorEntry: unknown): void {
  let existing: ClaudeDesktopConfig = {};
  if (existsSync(targetPath)) {
    try {
      const raw = readFileSync(targetPath, 'utf-8').trim();
      if (raw) existing = JSON.parse(raw) as ClaudeDesktopConfig;
      const backup = `${targetPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      writeFileSync(backup, raw + '\n', 'utf-8');
      stdout.write(`🛟 Backed up existing config → ${backup}\n`);
    } catch (error) {
      stdout.write(`❌ Could not read/parse existing Claude config at ${targetPath}. Aborting install to avoid data loss.\n`);
      stdout.write(`   ${error instanceof Error ? error.message : String(error)}\n`);
      stdout.write('   Fix or remove that file, then re-run.\n');
      process.exit(1);
    }
  } else {
    mkdirSync(resolve(targetPath, '..'), { recursive: true });
  }

  const merged: ClaudeDesktopConfig = {
    ...existing,
    mcpServers: { ...(existing.mcpServers ?? {}), 'email-orchestrator': orchestratorEntry },
  };
  writeFileSync(targetPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');

  stdout.write(`\n✅ Installed "email-orchestrator" into Claude Desktop:\n   ${targetPath}\n`);
  const others = Object.keys(existing.mcpServers ?? {}).filter(k => k !== 'email-orchestrator');
  if (others.length) stdout.write(`   (preserved existing MCP servers: ${others.join(', ')})\n`);
  stdout.write('\n👉 Fully quit Claude Desktop (Cmd+Q) and reopen it to load the agent.\n');
}

main();

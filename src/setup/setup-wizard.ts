#!/usr/bin/env node
/**
 * @module setup/setup-wizard
 * @description Interactive CLI that collects LLM + email-account settings and writes
 * a .env file. Run with: npm run setup
 *
 * The wizard only *records* what you type into your local .env — provider OAuth
 * (Gmail) and app passwords (Yahoo) are obtained by following the per-provider docs
 * in docs/. Nothing is sent anywhere.
 */

import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'path';
import { parseEnvFile, writeEnvFile, findProjectRoot } from './env-file.js';

const rl = readline.createInterface({ input: stdin, output: stdout });

async function ask(question: string, fallback = ''): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || fallback;
}

async function askYesNo(question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = (await rl.question(`${question} (${hint}): `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

function heading(text: string): void {
  stdout.write(`\n\x1b[1m\x1b[36m${text}\x1b[0m\n`);
}

async function main(): Promise<void> {
  const projectRoot = findProjectRoot();
  const envPath = resolve(projectRoot, '.env');
  const existing = parseEnvFile(envPath);
  const updates: Record<string, string> = {};

  stdout.write('\n=== Email AI Agent — Setup Wizard ===\n');
  stdout.write('Press Enter to accept the [default]. Ctrl+C to abort.\n');

  // --- LLM ---
  heading('1) AI model (LLM)');
  updates['LLM_PROVIDER'] = await ask('LLM provider (gemini|openai|anthropic|groq|ollama|custom)', existing['LLM_PROVIDER'] ?? 'gemini');
  updates['LLM_MODEL'] = await ask('Model name', existing['LLM_MODEL'] ?? 'gemma-3-27b-it');
  updates['LLM_API_KEY'] = await ask('API key (leave blank to keep existing)', existing['LLM_API_KEY'] ?? '');
  const baseUrl = await ask('Custom base URL (optional, for Ollama/LiteLLM/etc.)', existing['LLM_BASE_URL'] ?? '');
  if (baseUrl) updates['LLM_BASE_URL'] = baseUrl;

  // --- Gmail ---
  heading('2) Gmail account');
  if (await askYesNo('Configure a Gmail account?', Boolean(existing['GMAIL_EMAIL']))) {
    updates['GMAIL_EMAIL'] = await ask('Gmail address', existing['GMAIL_EMAIL'] ?? '');
    updates['GMAIL_DISPLAY_NAME'] = await ask('Display name', existing['GMAIL_DISPLAY_NAME'] ?? 'Gmail');
    stdout.write('  → Complete Gmail OAuth for the MCP server per docs/GMAIL-SETUP.md.\n');
  }

  // --- Zoho ---
  heading('3) Zoho Mail account (official hosted MCP)');
  if (await askYesNo('Configure a Zoho Mail account?', Boolean(existing['ZOHO_EMAIL']))) {
    updates['ZOHO_EMAIL'] = await ask('Zoho email', existing['ZOHO_EMAIL'] ?? '');
    updates['ZOHO_DISPLAY_NAME'] = await ask('Display name', existing['ZOHO_DISPLAY_NAME'] ?? 'Zoho Mail');
    updates['ZOHO_REGION'] = await ask('Data center region (in|com|eu|com.au|jp)', existing['ZOHO_REGION'] ?? 'in');
    updates['ZOHO_MCP_URL'] = await ask('Zoho MCP server URL (from mcp.zoho.com)', existing['ZOHO_MCP_URL'] ?? '');
    updates['ZOHO_MCP_TRANSPORT'] = await ask('Zoho MCP transport (sse|http)', existing['ZOHO_MCP_TRANSPORT'] ?? 'sse');
    const token = await ask('Zoho MCP auth token (optional)', existing['ZOHO_MCP_AUTH_TOKEN'] ?? '');
    if (token) updates['ZOHO_MCP_AUTH_TOKEN'] = token;
    stdout.write('  → See docs/ZOHO-SETUP.md to create the connector at mcp.zoho.com.\n');
  }

  // --- Yahoo ---
  heading('4) Yahoo Mail account (IMAP)');
  if (await askYesNo('Configure a Yahoo Mail account?', Boolean(existing['YAHOO_EMAIL']))) {
    updates['YAHOO_EMAIL'] = await ask('Yahoo email', existing['YAHOO_EMAIL'] ?? '');
    updates['YAHOO_APP_PASSWORD'] = await ask('Yahoo app password (leave blank to keep existing)', existing['YAHOO_APP_PASSWORD'] ?? '');
    updates['YAHOO_DISPLAY_NAME'] = await ask('Display name', existing['YAHOO_DISPLAY_NAME'] ?? 'Yahoo Mail');
    updates['YAHOO_IMAP_HOST'] = existing['YAHOO_IMAP_HOST'] ?? 'imap.mail.yahoo.com';
    updates['YAHOO_IMAP_PORT'] = existing['YAHOO_IMAP_PORT'] ?? '993';
    stdout.write('  → Generate an app password per docs/YAHOO-SETUP.md.\n');
  }

  // --- Outlook ---
  heading('5) Outlook account (via IMAP — personal Outlook.com/Hotmail)');
  if (await askYesNo('Configure an Outlook account?', Boolean(existing['OUTLOOK_EMAIL']))) {
    updates['OUTLOOK_EMAIL'] = await ask('Outlook email', existing['OUTLOOK_EMAIL'] ?? '');
    updates['OUTLOOK_APP_PASSWORD'] = await ask('Outlook app password (leave blank to keep existing)', existing['OUTLOOK_APP_PASSWORD'] ?? '');
    updates['OUTLOOK_DISPLAY_NAME'] = await ask('Display name', existing['OUTLOOK_DISPLAY_NAME'] ?? 'Outlook');
    updates['OUTLOOK_IMAP_HOST'] = existing['OUTLOOK_IMAP_HOST'] ?? 'outlook.office365.com';
    updates['OUTLOOK_IMAP_PORT'] = existing['OUTLOOK_IMAP_PORT'] ?? '993';
    stdout.write('  → Personal Outlook.com needs 2FA + an app password. M365 work accounts may have IMAP disabled (see docs/OUTLOOK-SETUP.md).\n');
  }

  // --- Notifications & schedule ---
  heading('6) Notifications & scheduled digests');
  updates['NOTIFICATIONS_ENABLED'] = (await askYesNo('Enable desktop notifications?', existing['NOTIFICATIONS_ENABLED'] !== 'false')) ? 'true' : 'false';
  updates['DIGEST_SCHEDULE'] = await ask('Digest times (up to 3, comma-separated HH:MM)', existing['DIGEST_SCHEDULE'] ?? '09:00,14:00,19:00');
  updates['TIMEZONE'] = await ask('Timezone', existing['TIMEZONE'] ?? 'Asia/Kolkata');
  const pollMinutes = await ask('Real-time urgent-email poll interval in minutes (0 = off)', existing['URGENT_POLL_MINUTES'] ?? '0');
  updates['URGENT_POLL_MINUTES'] = pollMinutes;

  updates['LOG_LEVEL'] = existing['LOG_LEVEL'] ?? 'info';

  // --- Write ---
  writeEnvFile(envPath, updates);
  heading('Done!');
  stdout.write(`Wrote configuration to ${envPath}\n`);
  stdout.write('\nNext steps:\n');
  stdout.write('  1. Complete each provider\'s auth (see docs/).\n');
  stdout.write('  2. npm run test-connections   # verify LLM + provider connectivity\n');
  stdout.write('  3. npm run generate-config     # write claude_desktop_config.json\n');
  stdout.write('  4. npm run build && restart Claude Desktop.\n\n');

  rl.close();
}

main().catch(error => {
  stdout.write(`\nSetup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  rl.close();
  process.exit(1);
});

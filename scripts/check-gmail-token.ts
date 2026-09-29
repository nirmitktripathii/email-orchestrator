/**
 * Weekly Gmail sign-in check (run by a Windows scheduled task).
 *
 * Asks Google to trade the saved refresh token for a fresh access token. That is the
 * only reliable test: a token can look fine on disk and still be revoked or expired
 * (apps in OAuth "Testing" mode get refresh tokens that die after 7 days).
 *
 *   valid           → log one line, exit 0. Nothing opens.
 *   dead / missing  → open the sign-in flow (scripts/reauth-gmail.ts) so you can re-approve;
 *                     it is killed after 15 minutes if nobody completes it. Exit 1.
 *   anything else   → (offline, Google down, ...) log it and exit 2 WITHOUT opening a
 *                     browser — a network blip is not a reason to re-authorize.
 *
 * Never logs token values. Log: ~/.gmail-mcp/token-check.log
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/check-gmail-token.ts
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAuth2Client } from 'google-auth-library';

const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
const OAUTH_PATH = path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
const CREDENTIALS_PATH = process.env['GMAIL_CREDENTIALS_PATH'] || path.join(CONFIG_DIR, 'credentials.json');
const LOG_PATH = path.join(CONFIG_DIR, 'token-check.log');
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAUTH_TIMEOUT_MS = 15 * 60 * 1000;
const DEAD_TOKEN = /invalid_grant|invalid_token|unauthorized_client|invalid_client|No refresh token|token has been expired or revoked/i;

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, line + os.EOL);
  } catch {
    // Logging must never be the reason the check fails.
  }
}

/** Returns why the saved sign-in is unusable, or null if Google accepted it. */
async function checkToken(): Promise<{ dead: boolean; reason: string } | null> {
  if (!fs.existsSync(OAUTH_PATH)) {
    return { dead: false, reason: `no OAuth client keys at ${OAUTH_PATH} (see docs/GMAIL-SETUP.md)` };
  }
  let refreshToken: string | undefined;
  try {
    refreshToken = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'))['refresh_token'];
  } catch {
    return { dead: true, reason: `no readable credentials at ${CREDENTIALS_PATH}` };
  }
  if (!refreshToken) return { dead: true, reason: 'credentials have no refresh token' };

  const keysFile = JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf8'));
  const keys = keysFile.installed || keysFile.web;
  const client = new OAuth2Client(keys.client_id, keys.client_secret);
  // Only the refresh token: getAccessToken() must then go to Google to mint a new one.
  client.setCredentials({ refresh_token: refreshToken });
  try {
    const { token } = await client.getAccessToken();
    return token ? null : { dead: true, reason: 'Google returned no access token' };
  } catch (err) {
    const e = err as { message?: string; response?: { data?: { error?: string; error_description?: string } } };
    const detail = [e.response?.data?.error, e.response?.data?.error_description, e.message].filter(Boolean).join(': ');
    return { dead: DEAD_TOKEN.test(detail), reason: detail || String(err) };
  }
}

function runReauth(): Promise<number> {
  const tsx = path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsx, path.join('scripts', 'reauth-gmail.ts')], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      log('sign-in not completed within 15 minutes; closing it. Run `npx tsx scripts/reauth-gmail.ts` manually.');
      child.kill();
    }, REAUTH_TIMEOUT_MS);
    child.on('exit', code => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<number> {
  const problem = await checkToken();
  if (!problem) {
    log('Gmail token valid');
    return 0;
  }
  if (!problem.dead) {
    log(`Gmail token check inconclusive (no sign-in opened): ${problem.reason}`);
    return 2;
  }
  log(`Gmail token dead (${problem.reason}); opening the sign-in flow`);
  const code = await runReauth();
  const after = code === 0 ? await checkToken() : problem;
  log(after ? `re-sign-in did not fix it: ${after.reason}` : 'Gmail re-signed in; token valid. The orchestrator loads it on its next Gmail call.');
  return 1;
}

main().then(
  code => process.exit(code),
  err => {
    log(`check crashed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  },
);

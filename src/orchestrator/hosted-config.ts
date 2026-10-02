/**
 * @module hosted-config
 * @description Settings that only the hosted HTTP server needs, read from the environment and
 * checked up front. Everything fails closed: no token, no tool list, or a tool name that does not
 * exist stops the server from starting, instead of starting wide open.
 */

import { MIN_TOKEN_LENGTH } from './http-app.js';

export interface HostedConfig {
  readonly port: number;
  readonly token: string;
  readonly tools: ReadonlySet<string>;
}

/**
 * Turns "a, b" into a set, and refuses an empty list or a name that is not a real tool. Hosting
 * every tool is possible (list them all) but it has to be a choice.
 */
export function parseToolAllowList(raw: string | undefined, known: readonly string[]): Set<string> {
  const names = (raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new Error('EMAIL_HTTP_TOOLS is empty. List the tools the hosted server may offer, e.g. EMAIL_HTTP_TOOLS=account_status.');
  }
  const unknown = names.filter(n => !known.includes(n));
  if (unknown.length > 0) {
    throw new Error(`EMAIL_HTTP_TOOLS names tools that do not exist: ${unknown.join(', ')}.`);
  }
  return new Set(names);
}

export function loadHostedConfig(env: NodeJS.ProcessEnv, knownTools: readonly string[]): HostedConfig {
  const token = (env['MCP_HTTP_TOKEN'] ?? '').trim();
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`MCP_HTTP_TOKEN must be set to a secret of at least ${MIN_TOKEN_LENGTH} characters.`);
  }
  const port = Number(env['PORT'] ?? env['MCP_PORT'] ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a number between 1 and 65535.');
  }
  return { port, token, tools: parseToolAllowList(env['EMAIL_HTTP_TOOLS'], knownTools) };
}

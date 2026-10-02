/**
 * @module http-app
 * @description The hosted face of the orchestrator: MCP over Streamable HTTP, stateless, behind a
 * bearer token. It is a plain Node request handler (no web framework) so a test can run it on a
 * real socket.
 *
 * What it will and will not do:
 *   - `POST /mcp` is the only MCP endpoint. Every call needs `Authorization: Bearer <token>`.
 *   - `GET /healthz` answers without a token and reveals nothing but "ok".
 *   - Stateless: each request gets its own MCP server and transport, so there are no sessions to
 *     hijack and a restart loses nothing. Replies are plain JSON, not a stream.
 *   - No CORS headers are sent, so a browser page on another origin cannot call it.
 *   - The token is compared in constant time, and the handler refuses to be built with a weak one.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from './utils/logger.js';

const httpLogger = logger.child('http');

/** A bearer token shorter than this is guessable enough to refuse. */
export const MIN_TOKEN_LENGTH = 32;

const DEFAULT_MAX_BODY_BYTES = 1_000_000;

export interface HttpAppOptions {
  /** Builds a fresh MCP server for one request. */
  readonly buildServer: () => Server;
  /** The shared secret callers must present. */
  readonly token: string;
  readonly maxBodyBytes?: number;
}

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function rpcError(res: ServerResponse, status: number, code: number, message: string, headers?: Record<string, string>): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

/** Compare digests, not the strings, so the comparison takes the same time whatever the length. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1]!.trim() : '';
}

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createHttpHandler(options: HttpAppOptions): HttpHandler {
  if (options.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`The HTTP bearer token must be at least ${MIN_TOKEN_LENGTH} characters.`);
  }
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (path !== '/mcp') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!tokenMatches(bearer(req), options.token)) {
      rpcError(res, 401, -32001, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    if (req.method !== 'POST') {
      // Stateless server: there is no event stream to open and no session to delete.
      rpcError(res, 405, -32000, 'Method not allowed. POST JSON-RPC to /mcp.', { Allow: 'POST' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req, limit));
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        rpcError(res, 413, -32600, 'Request body too large');
      } else {
        rpcError(res, 400, -32700, 'Parse error');
      }
      return;
    }

    const server = options.buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (error) {
      httpLogger.error('MCP request failed', error);
      if (!res.headersSent) rpcError(res, 500, -32603, 'Internal error');
    }
  };
}

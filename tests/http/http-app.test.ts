import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AppConfig } from '../../src/orchestrator/core/types.js';
import { ProviderManager } from '../../src/orchestrator/providers/provider-manager.js';
import { EmailSummarizer } from '../../src/orchestrator/ai/summarizer.js';
import { EmailCategorizer } from '../../src/orchestrator/ai/categorizer.js';
import { ActionRecommender } from '../../src/orchestrator/ai/action-recommender.js';
import { EmailEnrichmentService } from '../../src/orchestrator/ai/enrichment.js';
import { allTools, type ToolContext } from '../../src/orchestrator/tools/index.js';
import { createServer } from '../../src/orchestrator/server.js';
import { createHttpHandler, MIN_TOKEN_LENGTH } from '../../src/orchestrator/http-app.js';
import { loadHostedConfig, parseToolAllowList } from '../../src/orchestrator/hosted-config.js';
import { FakeAdapter, FakeLLM, asLLM, defaultAiHandler, makeEmail } from '../helpers.js';

const TOKEN = 'a'.repeat(MIN_TOKEN_LENGTH) + 'secret';
const NAMES = allTools.map(t => t.name);

async function context(): Promise<ToolContext> {
  const adapter = new FakeAdapter('acctA', 'a@x.com', [makeEmail({ accountId: 'acctA', subject: 'Hello' })]);
  const providers = ProviderManager.withAdapters([adapter]);
  await providers.connectAll();
  const llm = asLLM(new FakeLLM(defaultAiHandler));
  const summarizer = new EmailSummarizer(llm);
  const categorizer = new EmailCategorizer(llm);
  const actionRecommender = new ActionRecommender(llm);
  const enrichment = new EmailEnrichmentService(summarizer, categorizer, actionRecommender);
  return { config: {} as AppConfig, providers, enrichment, summarizer, categorizer, actionRecommender };
}

describe('hosted HTTP server', () => {
  let http: HttpServer;
  let base: string;

  async function start(tools: string[], maxBodyBytes?: number): Promise<void> {
    const ctx = await context();
    const handler = createHttpHandler({
      token: TOKEN,
      maxBodyBytes,
      buildServer: () => createServer(ctx, { allowedTools: new Set(tools) }),
    });
    http = createHttpServer((req, res) => void handler(req, res));
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  }

  async function connect(token = TOKEN): Promise<Client> {
    const client = new Client({ name: 'test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return client;
  }

  const rpc = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body,
    });

  beforeEach(async () => {
    await start(['account_status', 'search_all']);
  });
  afterEach(async () => {
    await new Promise<void>(resolve => http.close(() => resolve()));
  });

  it('completes the MCP handshake and offers only the allowed tools', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['account_status', 'search_all']);
    await client.close();
  });

  it('runs an allowed tool', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'account_status', arguments: {} });
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/1\/1 account/);
    await client.close();
  });

  it('refuses a tool that exists but was not switched on', async () => {
    const client = await connect();
    for (const name of ['smart_reply', 'configure_schedule', 'trigger_digest_now', 'inbox_summary']) {
      expect(NAMES).toContain(name);
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]!.text).toMatch(/Unknown tool/);
    }
    await client.close();
  });

  it('rejects a call with no token, a wrong token, or a near-miss', async () => {
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    for (const headers of [{}, { Authorization: 'Bearer nope' }, { Authorization: `Bearer ${TOKEN}x` }, { Authorization: TOKEN }]) {
      const res = await rpc(init, headers);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
  });

  it('serves the health check without a token and reveals nothing else', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('does not answer other paths, and sends no CORS headers', async () => {
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/mcp/extra`)).status).toBe(404);
    const res = await rpc('{}', { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('is stateless: GET and DELETE are refused, with the token or without', async () => {
    for (const method of ['GET', 'DELETE']) {
      expect((await fetch(`${base}/mcp`, { method, headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
      expect((await fetch(`${base}/mcp`, { method })).status).toBe(401);
    }
  });

  it('answers bad JSON with a parse error', async () => {
    const res = await rpc('{not json', { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(400);
  });

  it('refuses an oversized body', async () => {
    await new Promise<void>(resolve => http.close(() => resolve()));
    await start(['account_status'], 200);
    const res = await rpc(JSON.stringify({ pad: 'x'.repeat(500) }), { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(413);
  });
});

describe('createHttpHandler', () => {
  it('will not be built with a short token', () => {
    expect(() => createHttpHandler({ token: 'short', buildServer: () => { throw new Error('unused'); } })).toThrow(/at least/);
    expect(() => createHttpHandler({ token: '', buildServer: () => { throw new Error('unused'); } })).toThrow(/at least/);
  });
});

describe('hosted configuration', () => {
  it('requires an explicit, valid tool list', () => {
    expect(() => parseToolAllowList(undefined, NAMES)).toThrow(/empty/);
    expect(() => parseToolAllowList(' , ', NAMES)).toThrow(/empty/);
    expect(() => parseToolAllowList('account_status,send_everything', NAMES)).toThrow(/send_everything/);
    expect([...parseToolAllowList(' account_status , search_all ', NAMES)]).toEqual(['account_status', 'search_all']);
  });

  it('requires a long token and a sane port', () => {
    const ok = { MCP_HTTP_TOKEN: TOKEN, EMAIL_HTTP_TOOLS: 'account_status', PORT: '10000' };
    expect(loadHostedConfig(ok, NAMES).port).toBe(10000);
    expect(() => loadHostedConfig({ ...ok, MCP_HTTP_TOKEN: 'short' }, NAMES)).toThrow(/MCP_HTTP_TOKEN/);
    expect(() => loadHostedConfig({ ...ok, MCP_HTTP_TOKEN: undefined }, NAMES)).toThrow(/MCP_HTTP_TOKEN/);
    expect(() => loadHostedConfig({ ...ok, PORT: '0' }, NAMES)).toThrow(/PORT/);
    expect(() => loadHostedConfig({ ...ok, PORT: 'abc' }, NAMES)).toThrow(/PORT/);
    expect(() => loadHostedConfig({ ...ok, EMAIL_HTTP_TOOLS: undefined }, NAMES)).toThrow(/EMAIL_HTTP_TOOLS/);
  });

  it('defaults the port to 8080', () => {
    expect(loadHostedConfig({ MCP_HTTP_TOKEN: TOKEN, EMAIL_HTTP_TOOLS: 'account_status' }, NAMES).port).toBe(8080);
  });
});

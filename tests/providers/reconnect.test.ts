/**
 * Regression tests for self-healing reconnection in BaseMcpAdapter / ImapAdapter.
 *
 * These reproduce the two production failures we fixed:
 *   - Yahoo "Unexpected close": the IMAP child's connection drops mid-request and
 *     the adapter must reconnect AND re-provision its account into the fresh child.
 *   - Any provider staying "connected" forever after its child died, so every later
 *     call threw instead of transparently reconnecting.
 *
 * A real child process isn't needed: we inject an in-memory MCP Server via a linked
 * transport pair and simulate a drop by closing the server side mid-call.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { BaseMcpAdapter } from '../../src/orchestrator/providers/provider-adapter.js';
import { ImapAdapter } from '../../src/orchestrator/providers/imap-adapter.js';
import { GmailAdapter, raiseIfErrorText } from '../../src/orchestrator/providers/gmail-adapter.js';
import { ProviderAuthError, ProviderConnectionError } from '../../src/orchestrator/utils/errors.js';
import type { EmailAccount, ProviderOperation } from '../../src/orchestrator/core/types.js';

/** One tool the fake server exposes: a name + a handler returning MCP text content. */
type ToolHandler = (args: Record<string, unknown>) => string;

/** Build + connect an in-memory MCP server exposing the given tools on `serverT`. */
function serveTools(serverT: Transport, tools: Record<string, ToolHandler>, onCall: (name: string) => void): void {
  const server = new Server({ name: 'fake-provider', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.keys(tools).map(name => ({ name, description: name, inputSchema: { type: 'object' } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async req => {
    const name = req.params.name;
    onCall(name);
    const handler = tools[name];
    const text = handler ? handler((req.params.arguments ?? {}) as Record<string, unknown>) : '[]';
    return { content: [{ type: 'text', text }] };
  });
  void server.connect(serverT);
}

function account(over: Partial<EmailAccount> = {}): EmailAccount {
  return {
    id: 'test-primary',
    provider: 'gmail',
    email: 'me@example.com',
    displayName: 'Test',
    isActive: true,
    mcpServerName: 'test',
    connection: { transport: 'stdio', command: 'node', args: [] },
    ...over,
  };
}

describe('BaseMcpAdapter self-healing reconnection', () => {
  /** Generic adapter that serves list_emails from an in-memory server and can drop a call. */
  class ReconnectingAdapter extends BaseMcpAdapter {
    public connectCount = 0;
    public callCount = 0;
    private dropOnCallNo: number | null = null;

    dropOnCall(n: number): void {
      this.dropOnCallNo = n;
    }

    protected override preferredToolNames(): Partial<Record<ProviderOperation, readonly string[]>> {
      return { listEmails: ['list_emails'] };
    }

    protected override createTransport(): Transport {
      this.connectCount++;
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      serveTools(
        serverT,
        {
          list_emails: () => JSON.stringify([{ id: '1', subject: 'ok' }]),
        },
        () => {
          this.callCount++;
          if (this.dropOnCallNo !== null && this.callCount === this.dropOnCallNo) {
            this.dropOnCallNo = null;
            void serverT.close(); // simulate the child dying mid-request
          }
        },
      );
      return clientT;
    }
  }

  it('connects, lists, and reports connected', async () => {
    const adapter = new ReconnectingAdapter(account());
    await adapter.connect();
    expect(adapter.isConnected()).toBe(true);
    const emails = await adapter.listEmails();
    expect(emails).toHaveLength(1);
    expect(adapter.connectCount).toBe(1);
  });

  it('reconnects and retries after a mid-call connection drop', async () => {
    const adapter = new ReconnectingAdapter(account());
    await adapter.connect();
    expect(adapter.connectCount).toBe(1);

    adapter.dropOnCall(1); // the first list_emails call kills the connection
    const emails = await adapter.listEmails(); // must transparently recover
    expect(emails).toHaveLength(1);
    expect(adapter.connectCount).toBe(2); // reconnected exactly once
    expect(adapter.isConnected()).toBe(true);
  });

  it('marks itself disconnected when the child drops between calls', async () => {
    const adapter = new ReconnectingAdapter(account());
    await adapter.connect();
    // Drop the very next call, then observe recovery on the call after.
    adapter.dropOnCall(1);
    await adapter.listEmails(); // triggers drop + auto-reconnect
    expect(adapter.isConnected()).toBe(true);
    const again = await adapter.listEmails();
    expect(again).toHaveLength(1);
  });
});

describe('ImapAdapter re-provisions its account across a reconnect', () => {
  class ImapTestAdapter extends ImapAdapter {
    public addCount = 0;
    public connectCount = 0;
    private dropNextLatest = false;
    private accountsOnThisChild = new Set<string>();

    dropNextGetLatest(): void {
      this.dropNextLatest = true;
    }

    protected override createTransport(): Transport {
      this.connectCount++;
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      // Each new child starts with an EMPTY account store — the crux of the Yahoo bug:
      // after a reconnect the account must be added again or reads fail.
      const accounts = new Set<string>();
      this.accountsOnThisChild = accounts;
      serveTools(
        serverT,
        {
          imap_list_accounts: () =>
            JSON.stringify({ accounts: [...accounts].map(name => ({ name })) }),
          imap_add_account: (args) => {
            const name = String(args['name'] ?? '');
            accounts.add(name);
            this.addCount++;
            return JSON.stringify({ ok: true, name });
          },
          imap_get_latest_emails: () => {
            if (this.dropNextLatest) {
              this.dropNextLatest = false;
              void serverT.close();
              return '[]';
            }
            return JSON.stringify({ messages: [{ uid: 5, subject: 'hi', from: 'a@b.com', flags: [] }] });
          },
        },
        () => {},
      );
      return clientT;
    }
  }

  function imapAccount(): EmailAccount {
    return account({
      id: 'yahoo-primary',
      provider: 'yahoo',
      email: 'me@yahoo.com',
      connection: {
        transport: 'stdio',
        command: 'node',
        args: [],
        env: {
          IMAP_HOST: 'imap.mail.yahoo.com',
          IMAP_PORT: '993',
          IMAP_USER: 'me@yahoo.com',
          IMAP_PASSWORD: 'app-password-1234',
          IMAP_TLS: 'true',
        },
      },
    });
  }

  it('provisions on connect and re-provisions on the fresh child after a drop', async () => {
    const adapter = new ImapTestAdapter(imapAccount());
    await adapter.connect();
    expect(adapter.addCount).toBe(1); // provisioned once on first connect

    const first = await adapter.listEmails();
    expect(first).toHaveLength(1);

    adapter.dropNextGetLatest(); // next read kills the child mid-request
    const recovered = await adapter.listEmails();
    expect(recovered).toHaveLength(1); // read still succeeds
    expect(adapter.connectCount).toBe(2); // reconnected to a fresh child
    expect(adapter.addCount).toBe(2); // AND re-provisioned the account into it
  });
});

describe('GmailAdapter unread count (gongrzhe text carries no read-state)', () => {
  // gongrzhe search_emails returns plain text with no read/unread flag. Reproduces the
  // bug where account_status reported 0 Gmail unread because every row defaulted to "read".
  class GmailTestAdapter extends GmailAdapter {
    protected override createTransport(): Transport {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      serveTools(
        serverT,
        {
          search_emails: () =>
            'ID: 1\nSubject: Hello\nFrom: a@b.com\nDate: 2026-08-10\n\n' +
            'ID: 2\nSubject: World\nFrom: c@d.com\nDate: 2026-08-10',
        },
        () => {},
      );
      return clientT;
    }
  }

  it('keeps unread results instead of dropping them all to zero', async () => {
    const adapter = new GmailTestAdapter(account({ provider: 'gmail' }));
    await adapter.connect();
    const unread = await adapter.listEmails({ unreadOnly: true, maxResults: 100 });
    expect(unread).toHaveLength(2); // was 0 before the fix
    expect(unread.every(e => !e.isRead)).toBe(true);
  });
});

describe('GmailAdapter errors disguised as text (gongrzhe never sets isError)', () => {
  class GmailErrorAdapter extends GmailAdapter {
    connectCount = 0;
    constructor(acct: EmailAccount, private readonly reply: string) {
      super(acct);
    }
    protected override createTransport(): Transport {
      this.connectCount++;
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      serveTools(serverT, { search_emails: () => this.reply }, () => {});
      return clientT;
    }
  }

  it('an expired login throws a sign-in error instead of listing zero emails', async () => {
    const adapter = new GmailErrorAdapter(account({ provider: 'gmail' }), 'Error: invalid_grant');
    await adapter.connect();
    // was: [] — an expired login looked exactly like an empty inbox
    await expect(adapter.listEmails()).rejects.toThrow(/invalid_grant.*reauth-gmail/s);
    await expect(adapter.listEmails()).rejects.toBeInstanceOf(ProviderAuthError);
    expect(adapter.connectCount).toBe(1); // an auth failure is not a dropped line: no reconnect loop
  });

  it('other error text throws a connection error', async () => {
    const adapter = new GmailErrorAdapter(account({ provider: 'gmail' }), 'Error: Quota exceeded for quota metric');
    await adapter.connect();
    await expect(adapter.searchEmails('from:someone')).rejects.toBeInstanceOf(ProviderConnectionError);
  });

  it('passes real results through, even with "Error:" inside a subject', () => {
    const text = 'ID: 1\nSubject: Error: build failed\nFrom: ci@x.com';
    expect(raiseIfErrorText(text)).toBe(text);
    expect(raiseIfErrorText({ messages: [] })).toEqual({ messages: [] });
  });
});

describe('GmailAdapter picks up a new sign-in without a restart', () => {
  class GmailReauthAdapter extends GmailAdapter {
    connectCount = 0;
    protected override createTransport(): Transport {
      this.connectCount++;
      const reply = this.connectCount === 1 ? 'Error: invalid_grant' : 'ID: 1\nSubject: Hello\nFrom: a@b.com';
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      serveTools(serverT, { search_emails: () => reply }, () => {});
      return clientT;
    }
  }

  it('restarts the Gmail child once the token file changes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-creds-'));
    const creds = path.join(dir, 'credentials.json');
    fs.writeFileSync(creds, '{}');
    const adapter = new GmailReauthAdapter(
      account({ provider: 'gmail', connection: { transport: 'stdio', command: 'node', env: { GMAIL_CREDENTIALS_PATH: creds } } }),
    );
    await adapter.connect();
    await expect(adapter.listEmails()).rejects.toBeInstanceOf(ProviderAuthError); // unchanged file: no restart
    expect(adapter.connectCount).toBe(1);

    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(creds, later, later); // the user re-authorized
    expect(await adapter.listEmails()).toHaveLength(1);
    expect(adapter.connectCount).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

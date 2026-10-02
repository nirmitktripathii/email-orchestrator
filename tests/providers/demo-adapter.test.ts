import { describe, expect, it } from 'vitest';
import { DemoAdapter, DEMO_ADDRESS } from '../../src/orchestrator/providers/demo-adapter.js';
import { ProviderManager } from '../../src/orchestrator/providers/provider-manager.js';
import type { EmailAccount } from '../../src/orchestrator/core/types.js';
import { assertHostedAccounts } from '../../src/orchestrator/hosted-config.js';
import { toolsByName, type ToolContext } from '../../src/orchestrator/tools/index.js';
import { EmailSummarizer } from '../../src/orchestrator/ai/summarizer.js';
import { EmailCategorizer } from '../../src/orchestrator/ai/categorizer.js';
import { ActionRecommender } from '../../src/orchestrator/ai/action-recommender.js';
import { EmailEnrichmentService } from '../../src/orchestrator/ai/enrichment.js';
import { FakeLLM, asLLM, defaultAiHandler } from '../helpers.js';
import type { AppConfig } from '../../src/orchestrator/core/types.js';

const demoAccount: EmailAccount = {
  id: 'demo',
  provider: 'demo',
  email: DEMO_ADDRESS,
  displayName: 'Demo',
  isActive: true,
  mcpServerName: 'demo',
};

describe('demo mailbox', () => {
  it('holds made-up mail only: every address is on a reserved .example domain', async () => {
    const adapter = new DemoAdapter();
    const emails = await adapter.listEmails();
    expect(emails.length).toBeGreaterThanOrEqual(10);
    for (const e of emails) {
      for (const c of [e.from, ...e.to]) expect(c.email).toMatch(/\.example$/);
    }
  });

  it('includes a bug report that matches the sandbox repository, and an injection attempt', async () => {
    const adapter = new DemoAdapter();
    const [bug] = await adapter.searchEmails('slugify');
    expect(bug!.body).toContain('github.com/nirmitktripathii/gitscout-demo-sandbox');
    const [trap] = await adapter.searchEmails('ignore all your previous');
    expect(trap!.subject).toMatch(/mailbox will be closed/);
  });

  it('dates the mail relative to now, newest first', async () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    const emails = await new DemoAdapter(undefined, now).listEmails();
    const times = emails.map(e => Date.parse(e.receivedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(now - times[0]!).toBeLessThan(24 * 3_600_000);
  });

  it('filters unread, caps results, and finds a message by id', async () => {
    const adapter = new DemoAdapter();
    const unread = await adapter.listEmails({ unreadOnly: true });
    expect(unread.every(e => !e.isRead)).toBe(true);
    expect(await adapter.listEmails({ maxResults: 3 })).toHaveLength(3);
    expect((await adapter.getEmail('m03'))?.subject).toMatch(/Invoice/);
    expect(await adapter.getEmail('nope')).toBeNull();
  });

  it('keeps drafts in memory and caps them, and reports status', async () => {
    const adapter = new DemoAdapter();
    for (let i = 0; i < 60; i++) {
      await adapter.createDraft({ to: ['a@b.example'], subject: 's', body: 'b' });
    }
    expect((await adapter.createDraft({ to: ['a@b.example'], subject: 's', body: 'b' })).draftId).toBe('demo-draft-61');
    await adapter.connect();
    expect(adapter.getStatus()).toMatchObject({ provider: 'demo', isConnected: true, accountEmail: DEMO_ADDRESS });
  });

  it('is built by the provider manager without an MCP connection, and works through the tools', async () => {
    const providers = new ProviderManager([demoAccount]);
    expect(providers.hasAccounts()).toBe(true);
    await providers.connectAll();
    const llm = asLLM(new FakeLLM(defaultAiHandler));
    const summarizer = new EmailSummarizer(llm);
    const categorizer = new EmailCategorizer(llm);
    const actionRecommender = new ActionRecommender(llm);
    const ctx: ToolContext = {
      config: {} as AppConfig,
      providers,
      enrichment: new EmailEnrichmentService(summarizer, categorizer, actionRecommender),
      summarizer,
      categorizer,
      actionRecommender,
    };
    const status = await toolsByName.get('account_status')!.handler({}, ctx);
    expect(status.text).toMatch(/1\/1 account/);
    const found = await toolsByName.get('search_all')!.handler({ query: 'slugify' }, ctx);
    expect(found.text).toMatch(/slugify/);
  });
});

describe('hosted accounts guard', () => {
  it('allows the demo mailbox alone', () => {
    expect(() => assertHostedAccounts([{ id: 'demo', provider: 'demo' }], {})).not.toThrow();
    expect(() => assertHostedAccounts([], {})).not.toThrow();
  });

  it('refuses real mailboxes unless explicitly allowed', () => {
    const accounts = [{ id: 'demo', provider: 'demo' }, { id: 'gmail-primary', provider: 'gmail' }];
    expect(() => assertHostedAccounts(accounts, {})).toThrow(/gmail-primary/);
    expect(() => assertHostedAccounts(accounts, { EMAIL_HTTP_ALLOW_REAL_ACCOUNTS: 'yes' })).toThrow();
    expect(() => assertHostedAccounts(accounts, { EMAIL_HTTP_ALLOW_REAL_ACCOUNTS: 'true' })).not.toThrow();
  });
});

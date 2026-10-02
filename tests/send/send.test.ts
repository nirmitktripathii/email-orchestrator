import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AppConfig } from '../../src/orchestrator/core/types.js';
import { ProviderManager } from '../../src/orchestrator/providers/provider-manager.js';
import { EmailSummarizer } from '../../src/orchestrator/ai/summarizer.js';
import { EmailCategorizer } from '../../src/orchestrator/ai/categorizer.js';
import { ActionRecommender } from '../../src/orchestrator/ai/action-recommender.js';
import { EmailEnrichmentService } from '../../src/orchestrator/ai/enrichment.js';
import { allTools, toolCatalog, type ToolContext } from '../../src/orchestrator/tools/index.js';
import { sendEmailTool } from '../../src/orchestrator/tools/send-tools.js';
import { createServer } from '../../src/orchestrator/server.js';
import { FOOTER, MAX_BODY, MAX_SUBJECT, SendPolicy } from '../../src/orchestrator/send/policy.js';
import { SmtpMailer, type Mailer, type OutgoingEmail } from '../../src/orchestrator/send/mailer.js';
import { loadSend } from '../../src/orchestrator/send/config.js';
import { FakeLLM, asLLM, defaultAiHandler } from '../helpers.js';

class RecordingMailer implements Mailer {
  sent: OutgoingEmail[] = [];
  fail = false;
  async send(message: OutgoingEmail) {
    if (this.fail) throw new Error('535 auth failed for smtp-user@secret-host');
    this.sent.push(message);
    return { id: `id-${this.sent.length}` };
  }
}

function context(send?: ToolContext['send']): ToolContext {
  const llm = asLLM(new FakeLLM(defaultAiHandler));
  const summarizer = new EmailSummarizer(llm);
  const categorizer = new EmailCategorizer(llm);
  const actionRecommender = new ActionRecommender(llm);
  return {
    config: {} as AppConfig,
    providers: ProviderManager.withAdapters([]),
    enrichment: new EmailEnrichmentService(summarizer, categorizer, actionRecommender),
    summarizer,
    categorizer,
    actionRecommender,
    ...(send ? { send } : {}),
  };
}

const ok = { to: 'me@example.com', subject: 'Report', body: 'Fixed the bug.' };

describe('SendPolicy', () => {
  it('builds one plain message with the footer, and lower-cases the address', () => {
    const msg = new SendPolicy().prepare({ ...ok, to: ' Me@Example.COM ' });
    expect(msg.to).toBe('me@example.com');
    expect(msg.subject).toBe('Report');
    expect(msg.text).toBe(`Fixed the bug.\n${FOOTER}`);
  });

  it.each([
    'a@b.com, c@d.com',
    'a@b.com;c@d.com',
    'Name <a@b.com>',
    'a@b.com\nBcc: x@y.com',
    'a b@c.com',
    'nobody',
    '@b.com',
    'a@b',
    '',
    42,
  ])('refuses a bad or multiple recipient: %j', to => {
    expect(() => new SendPolicy().prepare({ ...ok, to })).toThrow(/plain email address/);
  });

  it('refuses header injection through the subject', () => {
    expect(() => new SendPolicy().prepare({ ...ok, subject: 'Hi\r\nBcc: x@y.com' })).toThrow(/single line/);
  });

  it('enforces length limits and required fields', () => {
    const p = new SendPolicy();
    expect(() => p.prepare({ ...ok, subject: 'x'.repeat(MAX_SUBJECT + 1) })).toThrow(/subject/);
    expect(() => p.prepare({ ...ok, body: 'x'.repeat(MAX_BODY + 1) })).toThrow(/body/);
    expect(() => p.prepare({ ...ok, subject: '  ' })).toThrow(/subject/);
    expect(() => p.prepare({ ...ok, body: '' })).toThrow(/body/);
  });

  it('can be limited to named domains', () => {
    const p = new SendPolicy({ perRecipientPerHour: 5, globalPerHour: 30, allowedDomains: ['example.com'] });
    expect(() => p.prepare(ok)).not.toThrow();
    expect(() => p.prepare({ ...ok, to: 'x@evil.test' })).toThrow(/domain/);
  });

  it('caps per recipient and overall, and the window slides after an hour', () => {
    let now = 1_000_000;
    const p = new SendPolicy({ perRecipientPerHour: 2, globalPerHour: 3 }, () => now);
    p.prepare(ok);
    p.prepare(ok);
    expect(() => p.prepare(ok)).toThrow(/this hour/);
    p.prepare({ ...ok, to: 'b@example.com' });
    expect(() => p.prepare({ ...ok, to: 'c@example.com' })).toThrow(/busy/);
    now += 3_600_001;
    expect(() => p.prepare(ok)).not.toThrow();
  });

  it('does not spend the cap on a send that failed', () => {
    const p = new SendPolicy({ perRecipientPerHour: 1, globalPerHour: 5 });
    p.prepare(ok);
    p.undoLast();
    expect(() => p.prepare(ok)).not.toThrow();
  });
});

describe('send_email tool', () => {
  it('sends through the mailer with the policy applied', async () => {
    const mailer = new RecordingMailer();
    const out = await sendEmailTool.handler(ok, context({ mailer, policy: new SendPolicy() }));
    expect(out.text).toBe('Email sent to me@example.com.');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.text).toContain(FOOTER);
  });

  it('refuses when sending is not enabled', async () => {
    await expect(sendEmailTool.handler(ok, context())).rejects.toThrow(/not enabled/);
  });

  it('hides SMTP details from the model and gives the cap back when delivery fails', async () => {
    const mailer = new RecordingMailer();
    mailer.fail = true;
    const policy = new SendPolicy({ perRecipientPerHour: 1, globalPerHour: 5 });
    const ctx = context({ mailer, policy });
    await expect(sendEmailTool.handler(ok, ctx)).rejects.toThrow(/could not be sent/);
    await expect(sendEmailTool.handler(ok, ctx)).rejects.not.toThrow(/secret-host|smtp-user/);
    mailer.fail = false;
    await expect(sendEmailTool.handler(ok, ctx)).resolves.toBeDefined();
  });
});

describe('the send tool exists only when sending is on', () => {
  it('is absent from the default catalog, which keeps its 17 tools', () => {
    expect(allTools.map(t => t.name)).not.toContain('send_email');
    expect(toolCatalog(context())).toHaveLength(17);
    expect(toolCatalog(context({ mailer: new RecordingMailer(), policy: new SendPolicy() })).map(t => t.name)).toContain('send_email');
  });

  async function client(ctx: ToolContext, allowedTools?: Set<string>): Promise<Client> {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer(ctx, { allowedTools }).connect(b);
    const c = new Client({ name: 't', version: '1' });
    await c.connect(a);
    return c;
  }

  it('is neither listed nor callable on a default server', async () => {
    const c = await client(context());
    expect((await c.listTools()).tools.map(t => t.name)).not.toContain('send_email');
    const r = await c.callTool({ name: 'send_email', arguments: ok });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toMatch(/Unknown tool/);
  });

  it('is listed when on, and still hidden if the allow-list leaves it out', async () => {
    const ctx = context({ mailer: new RecordingMailer(), policy: new SendPolicy() });
    expect((await (await client(ctx)).listTools()).tools.map(t => t.name)).toContain('send_email');
    const narrow = await client(ctx, new Set(['account_status']));
    expect((await narrow.listTools()).tools.map(t => t.name)).toEqual(['account_status']);
    expect((await narrow.callTool({ name: 'send_email', arguments: ok })).isError).toBe(true);
  });
});

describe('loadSend', () => {
  const full = { EMAIL_SEND_ENABLED: 'true', SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u@example.com', SMTP_PASSWORD: 'pw' };

  it('is off unless EMAIL_SEND_ENABLED is exactly true', () => {
    expect(loadSend({})).toBeUndefined();
    expect(loadSend({ ...full, EMAIL_SEND_ENABLED: 'yes' })).toBeUndefined();
    expect(loadSend({ ...full, EMAIL_SEND_ENABLED: 'false' })).toBeUndefined();
  });

  it('refuses to start half configured, naming what is missing but never a value', () => {
    expect(() => loadSend({ EMAIL_SEND_ENABLED: 'true' })).toThrow(/SMTP_HOST, SMTP_USER, SMTP_PASSWORD/);
    expect(() => loadSend({ ...full, SMTP_PASSWORD: '' })).toThrow(/SMTP_PASSWORD/);
    expect(() => loadSend({ ...full, SMTP_PORT: 'abc' })).toThrow(/SMTP_PORT/);
    expect(() => loadSend({ ...full, EMAIL_SEND_GLOBAL_PER_HOUR: '0' })).toThrow(/EMAIL_SEND_GLOBAL_PER_HOUR/);
  });

  it('builds a setup with limits from the environment', () => {
    const setup = loadSend({ ...full, EMAIL_SEND_ALLOWED_DOMAINS: 'Example.com', EMAIL_SEND_PER_RECIPIENT_PER_HOUR: '1' }, new RecordingMailer());
    expect(setup).toBeDefined();
    expect(() => setup!.policy.prepare({ ...ok, to: 'x@other.test' })).toThrow(/domain/);
    setup!.policy.prepare(ok);
    expect(() => setup!.policy.prepare(ok)).toThrow(/this hour/);
  });
});

describe('SmtpMailer', () => {
  it('hands the message to the transport with the configured sender', async () => {
    const calls: unknown[] = [];
    const mailer = new SmtpMailer(
      { host: 'h', port: 587, user: 'u', password: 'p', from: 'Mission Control <u@example.com>' },
      { sendMail: async o => { calls.push(o); return { messageId: '<abc@h>' }; } },
    );
    const res = await mailer.send({ to: 'me@example.com', subject: 's', text: 't' });
    expect(res.id).toBe('<abc@h>');
    expect(calls).toEqual([{ from: 'Mission Control <u@example.com>', to: 'me@example.com', subject: 's', text: 't' }]);
  });
});

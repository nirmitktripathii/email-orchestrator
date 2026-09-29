import { describe, it, expect } from 'vitest';
import { ProviderManager, parseGlobalId } from '../../src/orchestrator/providers/provider-manager.js';
import { FakeAdapter, makeEmail } from '../helpers.js';

describe('parseGlobalId', () => {
  it('splits accountId:messageId', () => {
    expect(parseGlobalId('gmail-primary:abc:123')).toEqual({ accountId: 'gmail-primary', messageId: 'abc:123' });
  });
  it('returns null without a colon', () => {
    expect(parseGlobalId('nocolon')).toBeNull();
  });
});

describe('ProviderManager (with fake adapters)', () => {
  async function setup(failSecond = false) {
    const a = new FakeAdapter('acctA', 'a@x.com', [makeEmail({ accountId: 'acctA', isRead: false }), makeEmail({ accountId: 'acctA', isRead: true })]);
    const b = new FakeAdapter('acctB', 'b@x.com', [makeEmail({ accountId: 'acctB' })], { failOnList: failSecond });
    const mgr = ProviderManager.withAdapters([a, b]);
    await mgr.connectAll();
    return { mgr, a, b };
  }

  it('aggregates emails across all connected accounts', async () => {
    const { mgr } = await setup();
    const all = await mgr.listAllEmails();
    expect(all).toHaveLength(3);
  });

  it('isolates a failing account (resilient fan-out)', async () => {
    const { mgr } = await setup(true);
    const all = await mgr.listAllEmails();
    expect(all).toHaveLength(2); // acctB failed, acctA still returned
  });

  it('applies unreadOnly across accounts', async () => {
    const { mgr } = await setup();
    const unread = await mgr.listAllEmails({ unreadOnly: true });
    expect(unread.every(e => !e.isRead)).toBe(true);
  });

  it('routes getEmailByGlobalId to the right adapter', async () => {
    const { mgr, a } = await setup();
    const first = (await a.listEmails())[0]!;
    const fetched = await mgr.getEmailByGlobalId(first.globalId);
    expect(fetched.globalId).toBe(first.globalId);
  });

  it('throws for an unknown account in getEmailByGlobalId', async () => {
    const { mgr } = await setup();
    await expect(mgr.getEmailByGlobalId('ghost:1')).rejects.toThrow();
  });

  it('reports statuses for all accounts', async () => {
    const { mgr } = await setup();
    const statuses = mgr.getStatuses();
    expect(statuses).toHaveLength(2);
    expect(statuses.every(s => s.isConnected)).toBe(true);
  });
});

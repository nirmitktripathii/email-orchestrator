import { describe, it, expect } from 'vitest';
import { normalizeEmail, normalizeEmails } from '../../src/orchestrator/core/email-normalizer.js';

describe('email-normalizer', () => {
  it('normalizes a Gmail-style raw email', () => {
    const raw = {
      id: 'abc123',
      subject: 'Hello',
      from: 'Alice <alice@example.com>',
      to: 'bob@example.com',
      snippet: 'hi there',
      labelIds: ['UNREAD', 'INBOX'],
      threadId: 't1',
    };
    const email = normalizeEmail(raw, 'gmail', 'gmail-primary', 'bob@example.com');
    expect(email.id).toBe('abc123');
    expect(email.globalId).toBe('gmail-primary:abc123');
    expect(email.from).toEqual({ name: 'Alice', email: 'alice@example.com' });
    expect(email.isRead).toBe(false); // UNREAD label present
    expect(email.threadId).toBe('t1');
  });

  it('parses object-form contacts and marks read when no UNREAD label', () => {
    const raw = {
      messageId: 'x1',
      Subject: 'Report',
      from: { name: 'Carol', email: 'carol@example.com' },
      labelIds: ['INBOX'],
    };
    const email = normalizeEmail(raw, 'gmail', 'a', 'me@example.com');
    expect(email.from.name).toBe('Carol');
    expect(email.isRead).toBe(true);
    expect(email.subject).toBe('Report');
  });

  it('throws when the id is missing', () => {
    expect(() => normalizeEmail({ subject: 'no id' }, 'imap', 'a', 'me@example.com')).toThrow();
  });

  it('skips un-normalizable emails in a batch', () => {
    const raws = [{ id: '1', subject: 'ok' }, { subject: 'missing id' }, { uid: '2', subject: 'ok2' }];
    const out = normalizeEmails(raws, 'imap', 'yahoo', 'me@yahoo.com');
    expect(out).toHaveLength(2);
    expect(out.map(e => e.id)).toEqual(['1', '2']);
  });
});

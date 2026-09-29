/**
 * Shared test fixtures and fakes. Not a test file itself.
 */

import type { NormalizedEmail, EmailDraft, DraftResult, AccountSummary, EmailQueryOptions } from '../src/orchestrator/core/types.js';
import type { LLMClient, ChatMessage } from '../src/orchestrator/ai/llm-client.js';
import type { ProviderAdapter } from '../src/orchestrator/providers/provider-adapter.js';

let counter = 0;

export function makeEmail(over: Partial<NormalizedEmail> = {}): NormalizedEmail {
  counter += 1;
  const id = over.id ?? `m${counter}`;
  const accountId = over.accountId ?? 'acct';
  const base: NormalizedEmail = {
    id,
    globalId: `${accountId}:${id}`,
    provider: 'gmail',
    accountId,
    accountEmail: 'me@example.com',
    from: { name: 'Sender', email: 'sender@example.com' },
    to: [{ name: 'Me', email: 'me@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Test subject',
    date: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    snippet: 'a short preview',
    body: 'the body of the email',
    isRead: false,
    isStarred: false,
    isDraft: false,
    labels: [],
    folder: 'INBOX',
    hasAttachments: false,
    attachments: [],
  };
  return { ...base, ...over, globalId: `${accountId}:${id}` };
}

/** A fake LLM whose completeJSON/complete route through one handler. */
export class FakeLLM {
  public calls = 0;
  constructor(private readonly handler: (messages: readonly ChatMessage[]) => unknown) {}

  async complete(options: { messages: readonly ChatMessage[] }) {
    this.calls += 1;
    return {
      content: JSON.stringify(this.handler(options.messages)),
      model: 'fake',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
      latencyMs: 1,
    };
  }

  async completeJSON<T>(options: { messages: readonly ChatMessage[] }, validator?: (d: unknown) => T): Promise<T> {
    this.calls += 1;
    const data = this.handler(options.messages);
    return validator ? validator(data) : (data as T);
  }

  getStats() {
    return { totalTokensUsed: 0, requestCount: this.calls, provider: 'fake', model: 'fake' };
  }
}

export function asLLM(fake: FakeLLM): LLMClient {
  return fake as unknown as LLMClient;
}

/** A handler that returns sensible shapes for every prompt the engines send. */
export function defaultAiHandler(messages: readonly ChatMessage[]): unknown {
  const text = messages.map(m => m.content).join('\n').toLowerCase();
  if (text.includes('categorize the following email')) {
    return { category: 'urgent', urgencyScore: 9, priority: 'critical', requiresResponse: true, deadlineDetected: null, reasoning: 'deadline today' };
  }
  if (text.includes('extract all actionable tasks')) {
    return { tasks: [{ description: 'do the thing', priority: 'high', source: 'body' }] };
  }
  if (text.includes('summarize the following email')) {
    return { summary: '• first point\n• second point\n• third point', keyTopics: ['project', 'deadline'], sentiment: 'neutral' };
  }
  if (text.includes('suggest 1-3 appropriate actions')) {
    return { suggestedActions: [{ type: 'reply', description: 'Reply promptly', priority: 'high', reasoning: 'needs a response' }] };
  }
  if (text.includes('comprehensive inbox summary')) {
    return { digest: 'You have urgent items to handle.', topPriorities: ['Handle urgent email'], actionPlan: 'Start with urgent.' };
  }
  if (text.includes('draft a')) {
    return { subject: 'Re: Test subject', body: 'Thanks, will do.', tone: 'professional', notes: '' };
  }
  if (text.includes('detailed explanation')) {
    return { explanation: 'This email is about X.', keyFacts: ['fact'], implications: ['impl'], expectedActions: ['act'] };
  }
  return {};
}

/** A fake provider adapter backed by an in-memory list of emails. */
export class FakeAdapter implements ProviderAdapter {
  public readonly provider = 'gmail' as const;
  public readonly displayName: string;
  private connected = false;

  constructor(
    public readonly accountId: string,
    public readonly email: string,
    private readonly emails: NormalizedEmail[],
    private readonly opts: { failOnList?: boolean } = {},
  ) {
    this.displayName = `${accountId} (${email})`;
  }

  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  async ensureConnected() { this.connected = true; }
  isConnected() { return this.connected; }

  async listEmails(options: EmailQueryOptions = {}): Promise<NormalizedEmail[]> {
    if (this.opts.failOnList) throw new Error('simulated list failure');
    let out = this.emails;
    if (options.unreadOnly) out = out.filter(e => !e.isRead);
    if (options.maxResults) out = out.slice(0, options.maxResults);
    return out;
  }

  async searchEmails(query: string): Promise<NormalizedEmail[]> {
    return this.emails.filter(e => e.subject.toLowerCase().includes(query.toLowerCase()));
  }

  async getEmail(id: string): Promise<NormalizedEmail | null> {
    return this.emails.find(e => e.id === id) ?? null;
  }

  async createDraft(_draft: EmailDraft): Promise<DraftResult> {
    return { draftId: 'draft-1', accountId: this.accountId, provider: this.provider };
  }

  getStatus(): AccountSummary {
    return {
      accountId: this.accountId,
      accountEmail: this.email,
      provider: this.provider,
      totalEmails: this.emails.length,
      unreadCount: this.emails.filter(e => !e.isRead).length,
      isConnected: this.connected,
    };
  }
}

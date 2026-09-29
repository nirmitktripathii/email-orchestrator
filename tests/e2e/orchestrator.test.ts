import { describe, it, expect, beforeEach } from 'vitest';
import type { AppConfig } from '../../src/orchestrator/core/types.js';
import { ProviderManager } from '../../src/orchestrator/providers/provider-manager.js';
import { EmailSummarizer } from '../../src/orchestrator/ai/summarizer.js';
import { EmailCategorizer } from '../../src/orchestrator/ai/categorizer.js';
import { ActionRecommender } from '../../src/orchestrator/ai/action-recommender.js';
import { EmailEnrichmentService } from '../../src/orchestrator/ai/enrichment.js';
import { allTools, toolsByName, type ToolContext } from '../../src/orchestrator/tools/index.js';
import { FakeAdapter, FakeLLM, asLLM, defaultAiHandler, makeEmail } from '../helpers.js';

async function buildContext(): Promise<{ ctx: ToolContext; firstGlobalId: string }> {
  const emails = [
    makeEmail({ accountId: 'acctA', subject: 'URGENT: deadline today', isRead: false }),
    makeEmail({ accountId: 'acctA', subject: 'Newsletter', isRead: true }),
  ];
  const adapter = new FakeAdapter('acctA', 'a@x.com', emails);
  const providers = ProviderManager.withAdapters([adapter]);
  await providers.connectAll();

  const llm = asLLM(new FakeLLM(defaultAiHandler));
  const summarizer = new EmailSummarizer(llm);
  const categorizer = new EmailCategorizer(llm);
  const actionRecommender = new ActionRecommender(llm);
  const enrichment = new EmailEnrichmentService(summarizer, categorizer, actionRecommender);

  const ctx: ToolContext = {
    config: {} as AppConfig,
    providers,
    enrichment,
    summarizer,
    categorizer,
    actionRecommender,
  };
  return { ctx, firstGlobalId: emails[0]!.globalId };
}

describe('orchestrator tools (e2e with fakes)', () => {
  let ctx: ToolContext;
  let firstGlobalId: string;

  beforeEach(async () => {
    ({ ctx, firstGlobalId } = await buildContext());
  });

  it('registers 17 tools with unique names', () => {
    expect(allTools.length).toBe(17);
    expect(toolsByName.size).toBe(17);
  });

  it('account_status reports the connected account', async () => {
    const out = await toolsByName.get('account_status')!.handler({}, ctx);
    expect(out.text).toMatch(/1\/1 account/);
    expect(out.text).toMatch(/connected/);
  });

  it('inbox_summary produces counts, breakdown and a digest', async () => {
    const out = await toolsByName.get('inbox_summary')!.handler({ enrichLevel: 'category' }, ctx);
    expect(out.text).toMatch(/Inbox Overview/);
    const data = out.data as { totalEmails: number; categoryBreakdown: unknown[] };
    expect(data.totalEmails).toBe(2);
    expect(data.categoryBreakdown.length).toBeGreaterThan(0);
  });

  it('prioritize_inbox ranks unread emails', async () => {
    const out = await toolsByName.get('prioritize_inbox')!.handler({}, ctx);
    expect(out.text).toMatch(/Prioritized inbox/);
  });

  it('search_all finds matching emails', async () => {
    const out = await toolsByName.get('search_all')!.handler({ query: 'URGENT' }, ctx);
    const data = out.data as { count: number };
    expect(data.count).toBe(1);
  });

  it('summarize_email returns a bullet summary for a specific email', async () => {
    const out = await toolsByName.get('summarize_email')!.handler({ globalId: firstGlobalId }, ctx);
    expect(out.text).toMatch(/first point/);
  });

  it('categorize_email classifies a specific email', async () => {
    const out = await toolsByName.get('categorize_email')!.handler({ globalId: firstGlobalId }, ctx);
    const data = out.data as { category: string; urgencyScore: number };
    expect(data.category).toBe('urgent');
    expect(data.urgencyScore).toBe(9);
  });

  it('smart_reply drafts (and can save) without sending', async () => {
    const out = await toolsByName.get('smart_reply')!.handler({ globalId: firstGlobalId, saveDraft: true }, ctx);
    expect(out.text).toMatch(/not sent/i);
    expect(out.text).toMatch(/Saved as draft/i);
    const data = out.data as { savedDraft: boolean };
    expect(data.savedDraft).toBe(true);
  });

  it('extract_tasks pulls out tasks', async () => {
    const out = await toolsByName.get('extract_tasks')!.handler({ globalId: firstGlobalId }, ctx);
    expect(out.text).toMatch(/do the thing/);
  });

  it('rejects a missing required argument', async () => {
    await expect(toolsByName.get('summarize_email')!.handler({}, ctx)).rejects.toThrow();
  });

  it('configure_schedule reports scheduler unavailable when none is wired', async () => {
    const out = await toolsByName.get('configure_schedule')!.handler({}, ctx);
    expect(out.text).toMatch(/not running/i);
  });
});

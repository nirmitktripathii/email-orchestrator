import { describe, it, expect } from 'vitest';
import { EmailSummarizer } from '../../src/orchestrator/ai/summarizer.js';
import { EmailCategorizer } from '../../src/orchestrator/ai/categorizer.js';
import { ActionRecommender } from '../../src/orchestrator/ai/action-recommender.js';
import { EmailEnrichmentService } from '../../src/orchestrator/ai/enrichment.js';
import { FakeLLM, asLLM, defaultAiHandler, makeEmail } from '../helpers.js';

function buildService() {
  const llm = asLLM(new FakeLLM(defaultAiHandler));
  return new EmailEnrichmentService(
    new EmailSummarizer(llm),
    new EmailCategorizer(llm),
    new ActionRecommender(llm),
    { cacheTtlSeconds: 60, maxCacheEntries: 100 },
  );
}

describe('EmailEnrichmentService', () => {
  it('enriches at category level (no summary)', async () => {
    const svc = buildService();
    const enr = await svc.enrich(makeEmail(), 'category');
    expect(enr.category).toBe('urgent');
    expect(enr.summary).toBe('');
    expect(enr.suggestedActions).toHaveLength(0);
  });

  it('enriches at full level (summary + actions + tasks)', async () => {
    const svc = buildService();
    const enr = await svc.enrich(makeEmail(), 'full');
    expect(enr.summary).toContain('first point');
    expect(enr.suggestedActions.length).toBeGreaterThan(0);
    expect(enr.extractedTasks.length).toBeGreaterThan(0);
  });

  it('caches enrichment so repeated calls do not re-hit the LLM', async () => {
    const fake = new FakeLLM(defaultAiHandler);
    const llm = asLLM(fake);
    const svc = new EmailEnrichmentService(
      new EmailSummarizer(llm),
      new EmailCategorizer(llm),
      new ActionRecommender(llm),
    );
    const email = makeEmail();
    await svc.enrich(email, 'category');
    const callsAfterFirst = fake.calls;
    await svc.enrich(email, 'category');
    expect(fake.calls).toBe(callsAfterFirst); // served from cache
  });

  it('enrichMany attaches enrichment and remembers emails', async () => {
    const svc = buildService();
    const emails = [makeEmail(), makeEmail()];
    const enriched = await svc.enrichMany(emails, 'category', 2);
    expect(enriched).toHaveLength(2);
    expect(enriched[0]!.aiEnrichment?.category).toBe('urgent');
    // remembered → resolvable from cache without a provider
    const cached = svc.getCachedEmail(emails[0]!.globalId);
    expect(cached).toBeDefined();
  });
});

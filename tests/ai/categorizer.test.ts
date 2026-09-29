import { describe, it, expect } from 'vitest';
import { EmailCategorizer } from '../../src/orchestrator/ai/categorizer.js';
import { FakeLLM, asLLM, defaultAiHandler, makeEmail } from '../helpers.js';

describe('EmailCategorizer', () => {
  it('categorizes using the LLM response', async () => {
    const llm = new FakeLLM(defaultAiHandler);
    const cat = new EmailCategorizer(asLLM(llm));
    const result = await cat.categorizeEmail(makeEmail({ subject: 'Deadline today' }));
    expect(result.category).toBe('urgent');
    expect(result.urgencyScore).toBe(9);
    expect(result.priority).toBe('critical');
    expect(result.requiresResponse).toBe(true);
  });

  it('clamps urgency score into 0-10', async () => {
    const llm = new FakeLLM(() => ({ category: 'informational', urgencyScore: 42, priority: 'low', requiresResponse: false }));
    const cat = new EmailCategorizer(asLLM(llm));
    const result = await cat.categorizeEmail(makeEmail());
    expect(result.urgencyScore).toBe(10);
  });

  it('falls back to keyword categorization when the LLM throws', async () => {
    const llm = new FakeLLM(() => { throw new Error('llm down'); });
    const cat = new EmailCategorizer(asLLM(llm));
    const promo = await cat.categorizeEmail(makeEmail({ subject: 'Huge SALE — unsubscribe anytime', body: 'discount offer' }));
    expect(promo.category).toBe('promotional');
    const invoice = await cat.categorizeEmail(makeEmail({ subject: 'Invoice #123', body: 'payment due amount due' }));
    expect(invoice.category).toBe('financial');
  });

  it('coerces an invalid category to uncategorized', async () => {
    const llm = new FakeLLM(() => ({ category: 'not-a-category', urgencyScore: 3, priority: 'low', requiresResponse: false }));
    const cat = new EmailCategorizer(asLLM(llm));
    const result = await cat.categorizeEmail(makeEmail());
    expect(result.category).toBe('uncategorized');
  });

  it('batch categorizes many emails', async () => {
    const llm = new FakeLLM(defaultAiHandler);
    const cat = new EmailCategorizer(asLLM(llm));
    const emails = [makeEmail(), makeEmail(), makeEmail()];
    const results = await cat.categorizeEmails(emails, 2);
    expect(results.size).toBe(3);
    for (const email of emails) expect(results.has(email.globalId)).toBe(true);
  });
});

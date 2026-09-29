import { describe, it, expect } from 'vitest';
import { EmailSummarizer } from '../../src/orchestrator/ai/summarizer.js';
import { FakeLLM, asLLM, defaultAiHandler, makeEmail } from '../helpers.js';

describe('EmailSummarizer', () => {
  it('summarizes a single email', async () => {
    const llm = new FakeLLM(defaultAiHandler);
    const sum = new EmailSummarizer(asLLM(llm));
    const result = await sum.summarizeEmail(makeEmail());
    expect(result.summary).toContain('first point');
    expect(result.keyTopics).toContain('project');
    expect(result.sentiment).toBe('neutral');
  });

  it('returns a friendly message for an empty inbox digest', async () => {
    const llm = new FakeLLM(defaultAiHandler);
    const sum = new EmailSummarizer(asLLM(llm));
    const digest = await sum.generateDigest([]);
    expect(digest.digest).toMatch(/no emails/i);
  });

  it('generates a digest for multiple emails', async () => {
    const llm = new FakeLLM(defaultAiHandler);
    const sum = new EmailSummarizer(asLLM(llm));
    const digest = await sum.generateDigest([makeEmail(), makeEmail()]);
    expect(digest.digest.length).toBeGreaterThan(0);
    expect(Array.isArray(digest.topPriorities)).toBe(true);
  });

  it('falls back to a computed digest when the LLM fails', async () => {
    const llm = new FakeLLM(() => { throw new Error('down'); });
    const sum = new EmailSummarizer(asLLM(llm));
    const digest = await sum.generateDigest([makeEmail({ isRead: false }), makeEmail({ isRead: true })]);
    expect(digest.digest).toMatch(/inbox overview/i);
  });
});

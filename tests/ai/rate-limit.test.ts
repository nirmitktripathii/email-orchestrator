import { describe, it, expect } from 'vitest';
import { RequestSpacer, classifyTransient } from '../../src/orchestrator/ai/llm-client.js';

/** A fake clock: sleeping just advances time, so the tests run instantly. */
function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    advance: (ms: number) => { t += ms; },
    sleeps,
  };
}

describe('RequestSpacer', () => {
  it('spaces consecutive requests 60/perMinute seconds apart', async () => {
    const c = fakeClock();
    const spacer = new RequestSpacer(15, c.now, c.sleep); // 4 s apart
    for (let i = 0; i < 4; i++) await spacer.wait();
    expect(c.sleeps).toEqual([4000, 4000, 4000]); // first request goes immediately
  });

  it('queues concurrent callers into distinct slots', async () => {
    const c = fakeClock();
    const waits: number[] = [];
    // Record the reserved waits without advancing the clock: all three arrive "at once".
    const spacer = new RequestSpacer(15, c.now, async (ms: number) => { waits.push(ms); });
    await Promise.all([spacer.wait(), spacer.wait(), spacer.wait()]);
    expect(waits).toEqual([4000, 8000]);
  });

  it('does not wait when requests are already far enough apart', async () => {
    const c = fakeClock();
    const spacer = new RequestSpacer(15, c.now, c.sleep);
    await spacer.wait();
    c.advance(10_000);
    await spacer.wait();
    expect(c.sleeps).toEqual([]);
  });

  it('is a no-op when disabled', async () => {
    const c = fakeClock();
    const spacer = new RequestSpacer(0, c.now, c.sleep);
    for (let i = 0; i < 5; i++) await spacer.wait();
    expect(c.sleeps).toEqual([]);
  });
});

describe('classifyTransient retry delay', () => {
  it.each([
    [`429 RESOURCE_EXHAUSTED {'error': {'details': [{'retryDelay': '46s'}]}}`, 46000],
    [`429 {"error":{"details":[{"retryDelay":"12s"}]}}`, 12000],
    ['429 Quota exceeded. Please retry in 46.5s.', 46500],
  ])('parses %s', (msg, ms) => {
    expect(classifyTransient(new Error(msg))).toEqual({ retryable: true, retryAfterMs: ms });
  });

  it('does not retry non-transient errors', () => {
    expect(classifyTransient(new Error('400 invalid argument'))).toEqual({ retryable: false });
  });
});

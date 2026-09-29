import { describe, it, expect } from 'vitest';
import { parseToolResult, coerceEmailArray } from '../../src/orchestrator/providers/provider-adapter.js';

describe('parseToolResult', () => {
  it('prefers structuredContent', () => {
    const result = { structuredContent: { emails: [{ id: '1' }] }, content: [{ type: 'text', text: 'ignored' }] };
    expect(parseToolResult(result)).toEqual({ emails: [{ id: '1' }] });
  });

  it('parses a JSON text block', () => {
    const result = { content: [{ type: 'text', text: '[{"id":"1"},{"id":"2"}]' }] };
    expect(parseToolResult(result)).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('extracts embedded JSON from human text', () => {
    const result = { content: [{ type: 'text', text: 'Here are your emails: [{"id":"9"}] done.' }] };
    expect(parseToolResult(result)).toEqual([{ id: '9' }]);
  });

  it('falls back to raw text when nothing parses', () => {
    const result = { content: [{ type: 'text', text: 'no json here' }] };
    expect(parseToolResult(result)).toBe('no json here');
  });
});

describe('coerceEmailArray', () => {
  it('handles a bare array', () => {
    expect(coerceEmailArray([{ id: '1' }])).toHaveLength(1);
  });
  it('unwraps common envelope keys', () => {
    expect(coerceEmailArray({ messages: [{ id: '1' }, { id: '2' }] })).toHaveLength(2);
    expect(coerceEmailArray({ data: [{ id: '3' }] })).toHaveLength(1);
  });
  it('wraps a single email object', () => {
    expect(coerceEmailArray({ id: '1', subject: 'x' })).toHaveLength(1);
  });
  it('returns empty for junk', () => {
    expect(coerceEmailArray('nonsense')).toHaveLength(0);
    expect(coerceEmailArray(null)).toHaveLength(0);
  });
});

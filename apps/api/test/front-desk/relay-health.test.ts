import { describe, expect, test } from 'vitest';
import { RelaySessions } from '../../src/front-desk/relay-sessions.ts';

const T0 = new Date('2026-10-12T12:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

describe('LLM circuit breaker', () => {
  test('two failures leave it healthy and the third trips it', () => {
    const r = new RelaySessions();
    r.recordLlmFailure(T0);
    r.recordLlmFailure(T0);
    expect(r.isLlmHealthy(T0)).toBe(true);
    r.recordLlmFailure(T0);
    expect(r.isLlmHealthy(at(1))).toBe(false);
    expect(r.isLlmHealthy(at(59_999))).toBe(false);
  });

  test('it is healthy again after 60 seconds and the count starts over', () => {
    const r = new RelaySessions();
    for (let k = 0; k < 3; k++) r.recordLlmFailure(T0);
    expect(r.isLlmHealthy(at(60_001))).toBe(true);
    r.recordLlmFailure(at(60_002));
    r.recordLlmFailure(at(60_002));
    expect(r.isLlmHealthy(at(60_003))).toBe(true);
  });

  test('a success resets the count', () => {
    const r = new RelaySessions();
    r.recordLlmFailure(T0);
    r.recordLlmFailure(T0);
    r.recordLlmSuccess(T0);
    r.recordLlmFailure(T0);
    r.recordLlmFailure(T0);
    expect(r.isLlmHealthy(T0)).toBe(true);
  });

  test('the llmHealthy getter reads true on a fresh registry and keeps the session set', () => {
    const r = new RelaySessions();
    expect(r.llmHealthy).toBe(true);
    r.add('CA1');
    expect(r.has('CA1')).toBe(true);
    expect(r.size).toBe(1);
  });
});

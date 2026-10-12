import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.ts';
import { anthropicFor } from '../src/providers/anthropic/index.ts';

const base = {
  FRONT_DESK_ROUTER_MODEL: 'claude-haiku-5-5',
  FRONT_DESK_ANSWER_MODEL: 'claude-opus-5-5',
  AGENT_DRAFT_MODEL: 'claude-opus-5-5',
  AGENT_EXTRACT_MODEL: 'claude-haiku-5-5',
};

describe('anthropicFor', () => {
  it('exposes every method without a network call when a key is set', () => {
    let calls = 0;
    const f = (async () => {
      calls += 1;
      throw new Error('fetch must not be called');
    }) as unknown as typeof fetch;
    const llm = anthropicFor({ ...base, ANTHROPIC_API_KEY: 'sk-ant-test-fake' } as unknown as Config, f);
    expect(llm).not.toBeNull();
    expect(llm!.configured).toBe(true);
    for (const m of ['route', 'answer', 'summarize', 'draftTexts', 'extractClaimReply'] as const) {
      expect(typeof llm![m]).toBe('function');
    }
    expect(calls).toBe(0);
  });

  it('is null without ANTHROPIC_API_KEY', () => {
    expect(anthropicFor({ ...base } as unknown as Config)).toBeNull();
  });
});

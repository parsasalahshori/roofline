import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.ts';
import { buildClients } from '../src/providers/anthropic/client.ts';
import { isRateLimit, toLlmError } from '../src/providers/anthropic/errors.ts';
import { anthropicFor } from '../src/providers/anthropic/index.ts';
import { LlmUnavailableError } from '../src/providers/llm.ts';

const FAKE_KEY = 'sk-ant-test-fake';

function cfg(key: string | undefined): Config {
  return {
    ANTHROPIC_API_KEY: key,
    FRONT_DESK_ROUTER_MODEL: 'claude-haiku-5-5',
    FRONT_DESK_ANSWER_MODEL: 'claude-opus-5-5',
  } as unknown as Config;
}

describe('anthropic client wiring', () => {
  it('anthropicFor returns null without ANTHROPIC_API_KEY', () => {
    expect(anthropicFor(cfg(undefined))).toBeNull();
    expect(buildClients(cfg(undefined))).toBeNull();
  });

  it('buildClients uses default model ids claude-haiku-5-5 / claude-opus-5-5', () => {
    const clients = buildClients(cfg(FAKE_KEY));
    expect(clients?.routerModel).toBe('claude-haiku-5-5');
    expect(clients?.answerModel).toBe('claude-opus-5-5');
  });

  it('anthropicFor returns a configured Llm with a key', () => {
    const llm = anthropicFor(cfg(FAKE_KEY));
    expect(llm?.configured).toBe(true);
  });
});

describe('toLlmError', () => {
  const headers = new Headers();
  const apiErrors = [
    new Anthropic.RateLimitError(429, { type: 'error' }, 'slow down', headers),
    new Anthropic.InternalServerError(500, { type: 'error' }, 'boom', headers),
    new Anthropic.APIConnectionError({ message: 'socket hang up' }),
    new Anthropic.APIError(400, { type: 'error' }, 'bad', headers),
  ];

  it('maps RateLimitError, APIConnectionError, InternalServerError and generic APIError to LlmUnavailableError', () => {
    for (const err of apiErrors) {
      expect(toLlmError(err)).toBeInstanceOf(LlmUnavailableError);
    }
  });

  it('leaves non-API errors unchanged and turns SDK aborts into AbortError', () => {
    const plain = new Error('plain');
    expect(toLlmError(plain)).toBe(plain);
    const abort = new Anthropic.APIUserAbortError();
    expect(toLlmError(abort)).toMatchObject({ name: 'AbortError' });
    const named = Object.assign(new Error('x'), { name: 'AbortError' });
    expect(toLlmError(named)).toBe(named);
  });

  it('isRateLimit is true only for RateLimitError', () => {
    expect(isRateLimit(apiErrors[0])).toBe(true);
    expect(isRateLimit(apiErrors[1])).toBe(false);
    expect(isRateLimit(new Error('429'))).toBe(false);
  });

  it('the API key never appears in LlmUnavailableError messages', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `key ${FAKE_KEY}` } }), {
        status: 500,
        headers: { 'content-type': 'application/json', 'x-api-key': FAKE_KEY },
      })) as unknown as typeof fetch;
    const clients = buildClients(cfg(FAKE_KEY), fetchImpl);
    let caught: unknown;
    try {
      await clients!.client.messages.create({
        model: 'claude-haiku-5-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      });
    } catch (e) {
      caught = e;
    }
    const mapped = toLlmError(caught);
    expect(mapped).toBeInstanceOf(LlmUnavailableError);
    expect((mapped as Error).message).not.toContain(FAKE_KEY);
    expect((mapped as Error).message).toContain('500');
  });
});

import type Anthropic from '@anthropic-ai/sdk';
import { toolJsonSchemas } from '@roofline/shared';
import type { AnswerInput, Llm, LlmEvent, TurnUsage } from '../llm.ts';
import { ANSWER_TIMEOUT_MS, type AnthropicClients } from './client.ts';
import { isRateLimit, toLlmError } from './errors.ts';
import { SYSTEM_PROMPT } from '../../front-desk/prompt.ts';

/** Fast mode is off by default; the 429 fallback path is implemented and tested via opts.fast. */
export const ANSWER_FAST_MODE = false;

type Done = Extract<LlmEvent, { type: 'done' }>;
const STOP: Record<string, Done['stopReason']> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  refusal: 'refusal',
  max_tokens: 'max_tokens',
};

export function createAnswer(c: AnthropicClients, opts?: { fast?: boolean }): Llm['answer'] {
  const fast = opts?.fast ?? ANSWER_FAST_MODE;

  async function* attempt(i: AnswerInput, useFast: boolean): AsyncGenerator<LlmEvent> {
    const start = Date.now();
    let firstTokenMs: number | null = null;
    const tools = toolJsonSchemas()
      .filter((t) => i.tools.includes(t.name))
      .map((t) => ({ ...t, strict: true, eager_input_streaming: true }));
    // No `thinking` (adaptive is always on for Opus 5.5), no tool_choice any/tool, no prefill.
    const params = {
      model: c.answerModel,
      max_tokens: 1024,
      betas: ['server-side-fallback-2026-07-01', ...(useFast ? ['fast-mode-2026-02-01'] : [])],
      fallbacks: 'default',
      ...(useFast ? { speed: 'fast' } : {}),
      output_config: { effort: 'low' },
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: i.companyBlock, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      tools,
      tool_choice: { type: 'auto' },
      messages: i.history,
      // Cast: the installed SDK types may lag the beta fields (speed, fallbacks shorthand, ttl).
    } as unknown as Parameters<typeof c.client.beta.messages.stream>[0];

    const stream = c.client.beta.messages.stream(params, { signal: i.signal, timeout: ANSWER_TIMEOUT_MS });
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        firstTokenMs ??= Date.now() - start;
        yield { type: 'text', text: ev.delta.text };
      }
    }
    const final = await stream.finalMessage();
    const stopReason = STOP[final.stop_reason ?? ''] ?? 'end_turn';
    if (stopReason !== 'refusal' && stopReason !== 'max_tokens') {
      for (const block of final.content as { type: string; id?: string; name?: string; input?: unknown }[]) {
        if (block.type !== 'tool_use') continue;
        let input = block.input;
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input);
          } catch {
            // leave the raw string; the engine's zod parse rejects it
          }
        }
        yield { type: 'tool_use', id: block.id as string, name: block.name as never, input };
      }
    }
    const usage: TurnUsage = {
      model: final.model ?? c.answerModel,
      inputTokens: final.usage.input_tokens,
      cachedTokens: final.usage.cache_read_input_tokens ?? 0,
      outputTokens: final.usage.output_tokens,
      firstTokenMs,
      totalMs: Date.now() - start,
    };
    yield { type: 'done', stopReason, usage, assistantContent: final.content as unknown as Anthropic.ContentBlock[] };
  }

  return async function* answer(i: AnswerInput): AsyncGenerator<LlmEvent> {
    let yielded = false;
    try {
      for await (const e of attempt(i, fast)) {
        yielded = true;
        yield e;
      }
    } catch (err) {
      if (fast && !yielded && isRateLimit(err)) {
        // Fast mode rate-limited before any output: retry once at standard speed (cache miss).
        try {
          yield* attempt(i, false);
          return;
        } catch (err2) {
          throw toLlmError(err2);
        }
      }
      throw toLlmError(err);
    }
  };
}

import { z } from 'zod';
import { CONVERSATION_OUTCOMES } from '@roofline/shared';
import { LlmUnavailableError, type Llm } from '../llm.ts';
import { ROUTE_TIMEOUT_MS, type AnthropicClients } from './client.ts';
import { toLlmError } from './errors.ts';
import { SUMMARY_PROMPT } from './prompts.ts';

// Keyword-free for strict structured output; zod enforces the limits.
export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    outcome: { type: 'string', enum: [...CONVERSATION_OUTCOMES] },
    followUps: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'outcome', 'followUps'],
  additionalProperties: false,
} as const;

const summarySchema = z
  .object({
    summary: z.string().max(1000),
    outcome: z.enum(CONVERSATION_OUTCOMES),
    followUps: z.array(z.string().max(200)).max(10),
  })
  .strict();

export function createSummarize(c: AnthropicClients): Llm['summarize'] {
  return async (input) => {
    const start = Date.now();
    let res;
    try {
      res = await c.client.messages.create(
        {
          model: c.routerModel,
          max_tokens: 800,
          output_config: { effort: 'low', format: { type: 'json_schema', schema: SUMMARY_SCHEMA as unknown as Record<string, unknown> } },
          system: [
            { type: 'text', text: SUMMARY_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
            { type: 'text', text: input.companyBlock, cache_control: { type: 'ephemeral', ttl: '1h' } },
          ],
          messages: [{ role: 'user', content: JSON.stringify({ transcript: input.transcript, actions: input.actions }) }],
        },
        { timeout: ROUTE_TIMEOUT_MS * 2 },
      );
    } catch (err) {
      throw toLlmError(err);
    }
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') {
      throw new LlmUnavailableError('Summary returned an unusable answer.');
    }
    const block = res.content.find((b) => b.type === 'text');
    let out;
    try {
      if (!block || block.type !== 'text') throw new Error('no text');
      out = summarySchema.parse(JSON.parse(block.text));
    } catch {
      throw new LlmUnavailableError('Summary returned an unusable answer.');
    }
    return {
      ...out,
      usage: {
        model: c.routerModel,
        inputTokens: res.usage.input_tokens,
        cachedTokens: res.usage.cache_read_input_tokens ?? 0,
        outputTokens: res.usage.output_tokens,
        firstTokenMs: null,
        totalMs: Date.now() - start,
      },
    };
  };
}

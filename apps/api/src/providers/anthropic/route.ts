import { ROUTER_INTENTS } from '@roofline/shared';
import { z } from 'zod';
import { LlmUnavailableError, type Llm } from '../llm.ts';
import { ROUTE_TIMEOUT_MS, type AnthropicClients } from './client.ts';
import { toLlmError } from './errors.ts';
import { ROUTER_PROMPT } from './prompts.ts';

const MOODS = ['calm', 'upset', 'angry'] as const;
const ROUTES = ['fast', 'opus', 'transfer', 'end'] as const;

// Strict structured output rejects length/range/pattern keywords; the zod parse below enforces limits.
export const ROUTE_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...ROUTER_INTENTS] },
    urgent: { type: 'boolean' },
    mood: { type: 'string', enum: [...MOODS] },
    route: { type: 'string', enum: [...ROUTES] },
    fastReply: { type: ['string', 'null'] },
  },
  required: ['intent', 'urgent', 'mood', 'route', 'fastReply'],
  additionalProperties: false,
} as const;

const decisionSchema = z
  .object({
    intent: z.enum(ROUTER_INTENTS),
    urgent: z.boolean(),
    mood: z.enum(MOODS),
    route: z.enum(ROUTES),
    fastReply: z.string().max(200).nullable(),
  })
  .strict();

export function createRoute(c: AnthropicClients): Llm['route'] {
  return async (input, signal) => {
    const start = Date.now();
    let res;
    try {
      res = await c.client.messages.create(
        {
          model: c.routerModel,
          max_tokens: 300,
          output_config: { effort: 'low', format: { type: 'json_schema', schema: ROUTE_SCHEMA as unknown as Record<string, unknown> } },
          system: [
            { type: 'text', text: ROUTER_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
            { type: 'text', text: input.companyBlock, cache_control: { type: 'ephemeral', ttl: '1h' } },
          ],
          messages: [{ role: 'user', content: JSON.stringify({ channel: input.channel, state: input.state, callerText: input.callerText }) }],
        },
        { signal, timeout: ROUTE_TIMEOUT_MS },
      );
    } catch (err) {
      throw toLlmError(err);
    }
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') {
      throw new LlmUnavailableError('Router returned an unusable answer.');
    }
    const block = res.content.find((b) => b.type === 'text');
    let decision;
    try {
      if (!block || block.type !== 'text') throw new Error('no text');
      decision = decisionSchema.parse(JSON.parse(block.text));
    } catch {
      throw new LlmUnavailableError('Router returned an unusable answer.');
    }
    return {
      ...decision,
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

import { z } from 'zod';
import { claimsGuard } from '@roofline/shared';
import { LlmUnavailableError, MAX_DRAFT_JOBS, type Llm } from '../llm.ts';
import type { AnthropicClients } from './client.ts';
import { DRAFT_INSTRUCTIONS, DRAFT_SYSTEM_PROMPT } from './draft-prompts.ts';
import { toLlmError } from './errors.ts';

// Keyword-free for strict structured output; zod and the filter enforce the limits.
export const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    texts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { jobId: { type: 'string' }, body: { type: 'string' } },
        required: ['jobId', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['texts'],
  additionalProperties: false,
} as const;

const draftSchema = z.object({ texts: z.array(z.object({ jobId: z.string(), body: z.string() })) }).strict();

type DraftMessage = {
  stop_reason: string | null;
  content: { type: string; text?: string }[];
  usage: { input_tokens: number; cache_read_input_tokens?: number | null; output_tokens: number };
};

export function createDraftTexts(c: AnthropicClients): Llm['draftTexts'] {
  return async (input) => {
    const { instruction, facts } = input;
    if (facts.length > MAX_DRAFT_JOBS) throw new RangeError(`At most ${MAX_DRAFT_JOBS} jobs per draft call.`);
    if (facts.length === 0) {
      return {
        texts: [],
        refused: false,
        usage: { model: c.draftModel, inputTokens: 0, cachedTokens: 0, outputTokens: 0, firstTokenMs: null, totalMs: 0 },
      };
    }
    const start = Date.now();
    const params = {
      model: c.draftModel,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: DRAFT_SCHEMA } },
      system: [
        { type: 'text', text: DRAFT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: DRAFT_INSTRUCTIONS[instruction], cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      messages: [{ role: 'user', content: JSON.stringify(facts) }],
      // Cast: the installed SDK types may lag the beta fields (fallbacks shorthand, ttl).
    } as unknown as Parameters<typeof c.client.beta.messages.create>[0];
    let res: DraftMessage;
    try {
      res = (await c.client.beta.messages.create(params, { timeout: 30_000 })) as unknown as DraftMessage;
    } catch (err) {
      throw toLlmError(err);
    }
    const usage = {
      model: c.draftModel,
      inputTokens: res.usage.input_tokens,
      cachedTokens: res.usage.cache_read_input_tokens ?? 0,
      outputTokens: res.usage.output_tokens,
      firstTokenMs: null,
      totalMs: Date.now() - start,
    };
    if (res.stop_reason === 'refusal') return { texts: [], refused: true, usage };
    if (res.stop_reason === 'max_tokens') throw new LlmUnavailableError('Draft returned an unusable answer.');
    let out;
    try {
      const block = res.content.find((b) => b.type === 'text');
      if (!block || typeof block.text !== 'string') throw new Error('no text');
      out = draftSchema.parse(JSON.parse(block.text));
    } catch {
      throw new LlmUnavailableError('Draft returned an unusable answer.');
    }
    const wanted = new Set(facts.map((f) => f.jobId));
    const byJob = new Map<string, string>();
    for (const t of out.texts) {
      if (!wanted.has(t.jobId) || byJob.has(t.jobId)) continue;
      byJob.set(t.jobId, t.body);
    }
    const texts: { jobId: string; body: string }[] = [];
    for (const f of facts) {
      const body = byJob.get(f.jobId);
      if (body === undefined || body.length > 300 || !claimsGuard(body).ok) continue;
      if (texts.some((t) => t.jobId === f.jobId)) continue;
      texts.push({ jobId: f.jobId, body });
    }
    return { texts, refused: false, usage };
  };
}

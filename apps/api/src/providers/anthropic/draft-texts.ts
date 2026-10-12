import { z } from 'zod';
import { claimsGuard } from '@roofline/shared';
import { LlmUnavailableError, MAX_DRAFT_JOBS, type DraftDropReason, type Llm } from '../llm.ts';
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

/** Up to 25 texts of up to 300 characters, plus the JSON around them; a truncated answer sends the whole batch to templates. */
export const DRAFT_MAX_TOKENS = 6000;

type DraftMessage = {
  model?: string;
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
      max_tokens: DRAFT_MAX_TOKENS,
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
      // With the server-side fallback the answering model may differ from the one asked for.
      model: typeof res.model === 'string' && res.model !== '' ? res.model : c.draftModel,
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
    const dropped: { jobId: string; reason: DraftDropReason }[] = [];
    const byJob = new Map<string, string>();
    for (const t of out.texts) {
      if (!wanted.has(t.jobId)) {
        dropped.push({ jobId: t.jobId, reason: 'unknown_job' });
        continue;
      }
      if (byJob.has(t.jobId)) {
        dropped.push({ jobId: t.jobId, reason: 'duplicate' });
        continue;
      }
      byJob.set(t.jobId, t.body);
    }
    const texts: { jobId: string; body: string }[] = [];
    for (const f of facts) {
      const body = byJob.get(f.jobId);
      if (body === undefined) continue;
      if (body.length > 300) {
        dropped.push({ jobId: f.jobId, reason: 'too_long' });
        continue;
      }
      if (!claimsGuard(body).ok) {
        dropped.push({ jobId: f.jobId, reason: 'claims_guard' });
        continue;
      }
      // A review request is a marketing text: it must name the company and end with the opt-out line
      // (spec Decision 9). One that does not would be refused at step validation, so it is dropped here
      // and the caller writes it from the template instead.
      if (instruction === 'review_request' && (!body.includes(f.companyName) || !/Reply STOP to opt out\.?$/.test(body.trim()))) {
        dropped.push({ jobId: f.jobId, reason: 'review_rule' });
        continue;
      }
      texts.push({ jobId: f.jobId, body });
    }
    return dropped.length > 0 ? { texts, refused: false, usage, dropped } : { texts, refused: false, usage };
  };
}

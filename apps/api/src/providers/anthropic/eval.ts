import { z } from 'zod';
import type { Config } from '../../config.ts';
import { LlmUnavailableError, type TurnUsage } from '../llm.ts';
import { buildClients, ROUTE_TIMEOUT_MS, type AnthropicClients } from './client.ts';
import { toLlmError } from './errors.ts';

/*
 * The model calls of the scripted call evals (D1 Task 25), by hand only (npm run eval:front-desk). They live here because
 * the only Claude client is the one built in this folder (Ruling DA); the script imports these functions and constructs
 * nothing. Both use the router model (Haiku 5.5) with structured output, like route.ts. Nothing in CI calls them with a
 * real client: tests pass fakes of EvalModels, and the adapter test serves them a scripted fetch.
 */

export type TranscriptLine = { speaker: 'caller' | 'assistant'; text: string };

export type SimulateInput = {
  /** One sentence on who the caller is and what they want. */
  persona: string;
  /** The caller's lines for this scenario, in order. */
  script: readonly string[];
  /** The conversation so far, oldest first. */
  transcript: readonly TranscriptLine[];
  /** How many caller lines have been spoken so far. */
  spoken: number;
};
export type SimulateOutput = { text: string; done: boolean; usage: TurnUsage };

export type GradeInput = {
  /** The criteria, each scored on its own. */
  rubric: readonly string[];
  transcript: readonly TranscriptLine[];
};
export type ToneScore = { criterion: string; score: number; note: string };
export type GradeOutput = { scores: ToneScore[]; usage: TurnUsage };

export interface EvalModels {
  simulateCaller(input: SimulateInput, signal?: AbortSignal): Promise<SimulateOutput>;
  gradeTone(input: GradeInput, signal?: AbortSignal): Promise<GradeOutput>;
}

// Frozen prompts: no time-varying text, so they cache.
export const SIMULATOR_PROMPT = [
  'You play a person phoning a roofing company that is answered by an AI assistant. You are the caller, nothing else.',
  'You are given a persona, a script of the things the caller means to say in order, and the conversation so far.',
  'Say the next scripted line, in your own natural spoken words, one to three short sentences. If the assistant just asked you something, answer it from the persona first (names, streets and details come from the persona and the script, never invent new ones), then carry on with the script.',
  'Stay in character. Do not help the assistant, do not mention a script, and do not explain what you are doing.',
  'Set done to true, with empty text, when the script is finished and the assistant has nothing left to answer, or when the assistant has said goodbye or is connecting you to a person.',
].join('\n');

export const GRADER_PROMPT = [
  'You grade the tone of an AI assistant on a roofing company phone call. You are given the conversation and a rubric of criteria.',
  'Score each criterion from 1 (clearly fails) to 5 (clearly meets), judging only the assistant lines. Give a note of one short sentence for each.',
  'Judge tone and manner only. Do not judge whether the right tools were used; that is checked elsewhere.',
  'Return one score per criterion, in the order given, and repeat the criterion text exactly.',
].join('\n');

const SIMULATE_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' }, done: { type: 'boolean' } },
  required: ['text', 'done'],
  additionalProperties: false,
} as const;

const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: { criterion: { type: 'string' }, score: { type: 'integer' }, note: { type: 'string' } },
        required: ['criterion', 'score', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['scores'],
  additionalProperties: false,
} as const;

const simulateSchema = z.object({ text: z.string().max(600), done: z.boolean() }).strict();
const gradeSchema = z
  .object({
    scores: z.array(z.object({ criterion: z.string(), score: z.number().int().min(1).max(5), note: z.string().max(400) }).strict()).max(40),
  })
  .strict();

async function structured<T>(
  c: AnthropicClients,
  o: { system: string; payload: unknown; schema: object; maxTokens: number; parse: (json: unknown) => T; signal?: AbortSignal },
): Promise<{ value: T; usage: TurnUsage }> {
  const start = Date.now();
  let res;
  try {
    res = await c.client.messages.create(
      {
        model: c.routerModel,
        max_tokens: o.maxTokens,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: o.schema as Record<string, unknown> } },
        system: [{ type: 'text', text: o.system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages: [{ role: 'user', content: JSON.stringify(o.payload) }],
      },
      { ...(o.signal ? { signal: o.signal } : {}), timeout: ROUTE_TIMEOUT_MS * 4 },
    );
  } catch (err) {
    throw toLlmError(err);
  }
  if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') throw new LlmUnavailableError('The eval model returned an unusable answer.');
  const block = res.content.find((b) => b.type === 'text');
  let value: T;
  try {
    if (!block || block.type !== 'text') throw new Error('no text');
    value = o.parse(JSON.parse(block.text));
  } catch {
    throw new LlmUnavailableError('The eval model returned an unusable answer.');
  }
  return {
    value,
    usage: {
      model: c.routerModel,
      inputTokens: res.usage.input_tokens,
      cachedTokens: res.usage.cache_read_input_tokens ?? 0,
      outputTokens: res.usage.output_tokens,
      firstTokenMs: null,
      totalMs: Date.now() - start,
    },
  };
}

export function createEvalModels(c: AnthropicClients): EvalModels {
  return {
    async simulateCaller(input, signal) {
      const { value, usage } = await structured(c, {
        system: SIMULATOR_PROMPT,
        payload: input,
        schema: SIMULATE_SCHEMA,
        maxTokens: 300,
        parse: (json) => simulateSchema.parse(json),
        ...(signal ? { signal } : {}),
      });
      return { text: value.text.trim(), done: value.done, usage };
    },
    async gradeTone(input, signal) {
      const { value, usage } = await structured(c, {
        system: GRADER_PROMPT,
        payload: input,
        schema: GRADE_SCHEMA,
        maxTokens: 1200,
        parse: (json) => gradeSchema.parse(json),
        ...(signal ? { signal } : {}),
      });
      return { scores: value.scores, usage };
    },
  };
}

/** The real eval models, or null when ANTHROPIC_API_KEY is unset (Ruling DA). */
export function evalModelsFor(config: Config, fetchImpl?: typeof fetch): EvalModels | null {
  const clients = buildClients(config, fetchImpl);
  return clients ? createEvalModels(clients) : null;
}

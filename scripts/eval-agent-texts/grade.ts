// The Haiku grade for one drafted text (G1 Task 18a). One call per case through the official
// TypeScript SDK; every failure is recorded on the case instead of stopping the run.
import Anthropic from '@anthropic-ai/sdk';
import { DRAFT_INSTRUCTIONS } from '../../apps/api/src/providers/anthropic/draft-prompts.ts';
import type { DraftKind, JobFacts } from '../../apps/api/src/providers/llm.ts';
import { GRADE_SCHEMA, GRADE_SYSTEM_PROMPT, parseGrade, type GradeOutcome, type Tokens } from './lib.ts';

export const GRADE_MAX_TOKENS = 1024;

/** The part of the SDK client the grader uses (a fake in the tests). */
export type GradeClient = {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): PromiseLike<Anthropic.Message> };
};

export function gradeRequest(model: string, kind: DraftKind, facts: JobFacts, text: string): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: GRADE_MAX_TOKENS,
    // No thinking settings and no prefill: Haiku 5.5 picks its own thinking; low effort keeps it short.
    output_config: { effort: 'low', format: { type: 'json_schema', schema: GRADE_SCHEMA } },
    system: GRADE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: JSON.stringify({ kind, whatTheKindShouldDo: DRAFT_INSTRUCTIONS[kind], facts, text }),
      },
    ],
  };
}

/** Maps an SDK error (by class, most specific first) to a short message without key, header or body. */
export function describeSdkError(err: unknown): string | null {
  if (err instanceof Anthropic.RateLimitError) return 'rate limited (429)';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'the request timed out';
  if (err instanceof Anthropic.APIConnectionError) return 'could not reach the API';
  if (err instanceof Anthropic.APIError) return `API error (${err.status ?? 'no status'})`;
  return null;
}

export async function gradeText(
  client: GradeClient,
  model: string,
  kind: DraftKind,
  facts: JobFacts,
  text: string,
): Promise<{ outcome: GradeOutcome; usage: Tokens | null }> {
  let res: Anthropic.Message;
  try {
    res = await client.messages.create(gradeRequest(model, kind, facts, text));
  } catch (err) {
    const message = describeSdkError(err);
    if (message === null) throw err;
    return { outcome: { status: 'error', error: message }, usage: null };
  }
  const usage: Tokens = {
    input: res.usage.input_tokens,
    cachedRead: res.usage.cache_read_input_tokens ?? 0,
    output: res.usage.output_tokens,
  };
  return { outcome: parseGrade(res), usage };
}

import type { Config } from '../../config.ts';
import { type Llm, LlmUnavailableError } from '../llm.ts';
import { buildClients } from './client.ts';
import { createRoute } from './route.ts';
import { createAnswer } from './answer.ts';
import { createSummarize } from './summarize.ts';

/** The real Claude client, or null when ANTHROPIC_API_KEY is unset (Rulings DA, DB). */
export function anthropicFor(config: Config, fetchImpl?: typeof fetch): Llm | null {
  const clients = buildClients(config, fetchImpl);
  if (!clients) return null;
  return {
    configured: true,
    route: createRoute(clients),
    answer: createAnswer(clients),
    summarize: createSummarize(clients),
    // G1 Agents: G1 Task 4 replaces these with Opus drafting and Haiku claim-reply extraction.
    draftTexts: async () => {
      throw new LlmUnavailableError('Not built yet.');
    },
    extractClaimReply: async () => {
      throw new LlmUnavailableError('Not built yet.');
    },
  };
}

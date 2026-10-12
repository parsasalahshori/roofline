import type { Config } from '../../config.ts';
import type { Llm } from '../llm.ts';
import { buildClients } from './client.ts';
import { createRoute } from './route.ts';
import { createAnswer } from './answer.ts';
import { createSummarize } from './summarize.ts';
import { createDraftTexts } from './draft-texts.ts';
import { createExtractClaimReply } from './extract-claim.ts';

/** The real Claude client, or null when ANTHROPIC_API_KEY is unset (Rulings DA, DB). */
export function anthropicFor(config: Config, fetchImpl?: typeof fetch): Llm | null {
  const clients = buildClients(config, fetchImpl);
  if (!clients) return null;
  return {
    configured: true,
    route: createRoute(clients),
    answer: createAnswer(clients),
    summarize: createSummarize(clients),
    draftTexts: createDraftTexts(clients),
    extractClaimReply: createExtractClaimReply(clients),
  };
}

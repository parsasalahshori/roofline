import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../../config.ts';

export type AnthropicClients = {
  /** Client for routes/summaries: timeout 5 s (route) is passed per call via requestOptions. */
  client: Anthropic;
  routerModel: string;
  answerModel: string;
  /** G1 agents: drafts customer texts (AGENT_DRAFT_MODEL). */
  draftModel: string;
  /** G1 agents: extracts claim-reply facts (AGENT_EXTRACT_MODEL). */
  extractModel: string;
};
export const ROUTE_TIMEOUT_MS = 5_000;
export const ANSWER_TIMEOUT_MS = 20_000;
export function buildClients(config: Config, fetchImpl?: typeof fetch): AnthropicClients | null {
  if (!config.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({
    apiKey: config.ANTHROPIC_API_KEY,
    maxRetries: 1,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return {
    client,
    routerModel: config.FRONT_DESK_ROUTER_MODEL,
    answerModel: config.FRONT_DESK_ANSWER_MODEL,
    draftModel: config.AGENT_DRAFT_MODEL,
    extractModel: config.AGENT_EXTRACT_MODEL,
  };
}

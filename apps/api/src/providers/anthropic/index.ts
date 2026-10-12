import type { Config } from '../../config.ts';
import type { Llm } from '../llm.ts';

/** The real Claude client. A stub in Task 4: it returns null and never builds a client (Rulings DA, DB). */
export function anthropicFor(config: Config): Llm | null {
  void config;
  return null;
}
// G1 Task 4: draftTexts (Opus) and extractClaimReply (Haiku) are implemented there, throwing LlmUnavailableError('Not built yet.') until then.

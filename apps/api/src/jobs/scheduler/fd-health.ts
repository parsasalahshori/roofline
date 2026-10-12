import type { AppDeps } from '../../app.ts';

/**
 * Worker-side stub. The LLM health flag is a circuit breaker inside RelaySessions (Ruling DQ):
 * the engine records each model success or failure there. The worker has no relay sessions, so
 * this schedule writes nothing.
 */
export async function fdHealth(deps: AppDeps, now: Date): Promise<void> {
  void deps;
  void now;
}

import { markVoiceUrlSet, numbersNeedingVoiceUrl } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { applyVoiceUrls, type VoiceUrlResult } from '../../front-desk/number-voice.ts';

/** How many numbers one repair pass takes (oldest first); the schedule runs every two minutes. */
const REPAIR_LIMIT = 20;

/** How many numbers the first Front Desk save of one company sets at most. */
const COMPANY_LIMIT = 100;

/**
 * Sets the voice URL on the company's Front Desk numbers that do not have it yet. Called by the first
 * Front Desk settings save (D1 Task 18) and by the repair pass below. Rows are read and marked on the
 * system pool here, since this is a scheduler module (boundaries.test.ts).
 */
export async function ensureVoiceUrl(deps: AppDeps, companyId: string): Promise<VoiceUrlResult> {
  const rows = await numbersNeedingVoiceUrl(deps.pools.system, companyId, COMPANY_LIMIT);
  return applyVoiceUrls(deps, rows, (numberId) => markVoiceUrlSet(deps.pools.system, numberId));
}

/** The repair pass across every company: up to `limit` numbers that still lack the voice URL. */
export async function repairVoiceUrls(deps: AppDeps, limit: number): Promise<VoiceUrlResult> {
  const rows = await numbersNeedingVoiceUrl(deps.pools.system, null, limit);
  return applyVoiceUrls(deps, rows, (numberId) => markVoiceUrlSet(deps.pools.system, numberId));
}

/**
 * Scheduled job `fd-health` (worker, every two minutes). The LLM health flag is a circuit breaker
 * inside RelaySessions (Ruling DQ), so the worker writes nothing for it. Its one job here is the
 * `fd-number-voice` repair pass: numbers without a voice URL get one. A failure of the whole pass is
 * logged without any id and never thrown, so the schedule keeps running.
 */
export async function fdHealth(deps: AppDeps, now: Date): Promise<void> {
  void now;
  try {
    await repairVoiceUrls(deps, REPAIR_LIMIT);
  } catch {
    console.error('Front Desk: the fd-number-voice repair pass failed.');
  }
}

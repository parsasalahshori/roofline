import { endStuckCallsForCompany, withTenant } from '@roofline/db';
import { companiesWithLiveCalls, markVoiceUrlAttempt, markVoiceUrlSet, numbersNeedingVoiceUrl } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { applyVoiceUrls, type VoiceUrlResult } from '../../front-desk/number-voice.ts';
import { systemContext } from '../../permissions.ts';

/** How many numbers one repair pass takes (least recently tried first); the schedule runs every two minutes. */
const REPAIR_LIMIT = 20;

/** How many stuck calls one pass ends at most per company. */
const STUCK_CALL_LIMIT = 100;

/** How many numbers the first Front Desk save of one company sets at most. */
const COMPANY_LIMIT = 100;

/** Stamps a failed attempt so numbers that keep failing move behind the rest (pre-review #39). */
const failedMarker = (deps: AppDeps) => (numberId: string) => markVoiceUrlAttempt(deps.pools.system, numberId, deps.clock.now());

/**
 * Sets the voice URL on the company's Front Desk numbers that do not have it yet. Called by the first
 * Front Desk settings save (D1 Task 18) and by the repair pass below. Rows are read and marked on the
 * system pool here, since this is a scheduler module (boundaries.test.ts).
 */
export async function ensureVoiceUrl(deps: AppDeps, companyId: string): Promise<VoiceUrlResult> {
  const rows = await numbersNeedingVoiceUrl(deps.pools.system, companyId, COMPANY_LIMIT);
  return applyVoiceUrls(deps, rows, (numberId) => markVoiceUrlSet(deps.pools.system, numberId), failedMarker(deps));
}

/** The repair pass across every company: up to `limit` numbers that still lack the voice URL. */
export async function repairVoiceUrls(deps: AppDeps, limit: number): Promise<VoiceUrlResult> {
  const rows = await numbersNeedingVoiceUrl(deps.pools.system, null, limit);
  return applyVoiceUrls(deps, rows, (numberId) => markVoiceUrlSet(deps.pools.system, numberId), failedMarker(deps));
}

/**
 * Scheduled job `fd-health` (worker, every two minutes). The LLM health flag is a circuit breaker
 * inside RelaySessions (Ruling DQ), so the worker writes nothing for it. Its one job here is the
 * `fd-number-voice` repair pass: numbers without a voice URL get one. It then ends calls stuck live for
 * too long (endStuckCalls below) and queues their `fd-after-call`. A failure of the whole pass is
 * logged without any id and never thrown, so the schedule keeps running.
 */
export async function fdHealth(deps: AppDeps, now: Date): Promise<void> {
  try {
    await repairVoiceUrls(deps, REPAIR_LIMIT);
  } catch {
    console.error('Front Desk: the fd-number-voice repair pass failed.');
  }
  await endStuckCalls(deps, now);
}

/**
 * Calls whose Twilio status callback never came: ends them and queues their after-call work (Ruling BJ).
 * app_system lists only the companies with a live call; each company's stuck calls ('ai' over 35 minutes,
 * 'ringing'/'ringing_team' over 4 hours) are ended in its own tenant transaction. The after-call job carries
 * `swept`, so a swept call never gets a text-back (final review CV#3). Ids only in logs; never throws.
 */
export async function endStuckCalls(deps: AppDeps, now: Date): Promise<void> {
  let companyIds: string[];
  try {
    companyIds = await companiesWithLiveCalls(deps.pools.system);
  } catch {
    console.error('Front Desk: listing companies with live calls failed.');
    return;
  }
  for (const companyId of companyIds) {
    const ctx = systemContext(companyId);
    let ended: string[];
    try {
      ended = await withTenant(deps.pools, ctx, (tx) => endStuckCallsForCompany(tx, ctx, now, STUCK_CALL_LIMIT));
    } catch {
      console.error(`Front Desk: ending stuck calls failed company=${companyId}`);
      continue;
    }
    for (const callSid of ended) {
      try {
        await deps.jobs.send('fd-after-call', { companyId, callSid, swept: true }, { singletonKey: `fd-after-call:${callSid}` });
      } catch {
        console.error(`fd-after-call enqueue failed company=${companyId}`);
      }
    }
  }
}

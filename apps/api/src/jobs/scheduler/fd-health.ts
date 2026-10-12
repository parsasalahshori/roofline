import { endStuckCallsForCompany, frontDeskTextsOn, listIdleSmsConversationIds, withTenant } from '@roofline/db';
import { companiesWithLiveCalls, companyIdsForRetention, markVoiceUrlAttempt, markVoiceUrlSet, numbersNeedingVoiceUrl } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { IDLE_SMS_HOURS } from '../../front-desk/after-call.ts';
import { applyVoiceUrls, type VoiceUrlResult } from '../../front-desk/number-voice.ts';
import { systemContext } from '../../permissions.ts';

/** How many numbers one repair pass takes (least recently tried first); the schedule runs every two minutes. */
const REPAIR_LIMIT = 20;

/** How many stuck calls one pass ends at most per company. */
const STUCK_CALL_LIMIT = 100;

export { IDLE_SMS_HOURS };

/** How far back the idle pass still picks up threads the 24 h gap already ended without a summary (RC-2 #5). */
export const IDLE_SMS_ENDED_LOOKBACK_DAYS = 7;

/** The idle SMS pass runs at most this often (RC-2 #6): fd-health runs every two minutes, the pass on the first run of each slot. */
export const IDLE_SMS_EVERY_MINUTES = 30;

/** True for the fd-health run that starts an idle SMS slot: minutes 0-1 and 30-31 UTC (a late two-minute run still counts once). */
export function idleSmsPassDue(now: Date): boolean {
  return now.getUTCMinutes() % IDLE_SMS_EVERY_MINUTES < 2;
}

/** How many idle SMS conversations one company queues per pass. */
export const IDLE_SMS_PER_COMPANY_LIMIT = 50;

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
 * too long (endStuckCalls below) and queues their `fd-after-call`, then queues the after-call summary of
 * SMS threads idle for a day (queueIdleSmsAfterCalls). A failure of the whole pass is
 * logged without any id and never thrown, so the schedule keeps running.
 */
export async function fdHealth(deps: AppDeps, now: Date): Promise<void> {
  try {
    await repairVoiceUrls(deps, REPAIR_LIMIT);
  } catch {
    console.error('Front Desk: the fd-number-voice repair pass failed.');
  }
  await endStuckCalls(deps, now);
  if (idleSmsPassDue(now)) await queueIdleSmsAfterCalls(deps, now);
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

/**
 * Texting threads that went quiet: queue their after-call summary (singletonKey dedupes repeats). fd-health
 * calls it every IDLE_SMS_EVERY_MINUTES. A read-only company (Ruling BG) or one with Front Desk texting off
 * gets no paid summary (RC-2 #6); threads the 24 h gap ended without a summary are picked up for a week (RC-2 #5).
 */
export async function queueIdleSmsAfterCalls(deps: AppDeps, now: Date): Promise<void> {
  try {
    const before = new Date(now.getTime() - IDLE_SMS_HOURS * 3600_000);
    const companyIds = await companyIdsForRetention(deps.pools.system);
    for (const companyId of companyIds) {
      try {
        const ctx = systemContext(companyId);
        const endedSince = new Date(now.getTime() - IDLE_SMS_ENDED_LOOKBACK_DAYS * 24 * 3600_000);
        const ids = await withTenant(deps.pools, ctx, async (tx) =>
          (await frontDeskTextsOn(tx, ctx)) ? listIdleSmsConversationIds(tx, ctx, before, IDLE_SMS_PER_COMPANY_LIMIT, endedSince) : [],
        );
        for (const conversationId of ids) {
          try {
            await deps.jobs.send('fd-after-call', { companyId, conversationId }, { singletonKey: `fd-after-call:sms:${conversationId}` });
          } catch {
            console.error(`fd-after-call enqueue failed company=${companyId}`);
          }
        }
      } catch {
        console.error(`fd-idle-sms failed company=${companyId}`);
      }
    }
  } catch {
    console.error('Front Desk: the idle SMS pass failed.');
  }
}

import { listIdleSmsConversationIds, withTenant } from '@roofline/db';
import { companyIdsForRetention, endStuckCalls, markVoiceUrlAttempt, markVoiceUrlSet, numbersNeedingVoiceUrl } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { applyVoiceUrls, type VoiceUrlResult } from '../../front-desk/number-voice.ts';

/** How many numbers one repair pass takes (least recently tried first); the schedule runs every two minutes. */
const REPAIR_LIMIT = 20;

/** How many stuck calls one pass ends at most. */
const STUCK_CALL_LIMIT = 100;

/** An SMS conversation with no message for this long gets its after-call summary. */
export const IDLE_SMS_HOURS = 24;

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
 * over 35 minutes and queues their `fd-after-call`. A failure of the whole pass is
 * logged without any id and never thrown, so the schedule keeps running.
 */
export async function fdHealth(deps: AppDeps, now: Date): Promise<void> {
  try {
    await repairVoiceUrls(deps, REPAIR_LIMIT);
  } catch {
    console.error('Front Desk: the fd-number-voice repair pass failed.');
  }
  // Calls whose Twilio status callback never came: end them and queue their after-call work.
  try {
    const ended = await endStuckCalls(deps.pools.system, now, STUCK_CALL_LIMIT);
    for (const { companyId, callSid } of ended) {
      try {
        await deps.jobs.send('fd-after-call', { companyId, callSid }, { singletonKey: `fd-after-call:${callSid}` });
      } catch {
        console.error(`fd-after-call enqueue failed company=${companyId}`);
      }
    }
  } catch {
    console.error('Front Desk: ending stuck calls failed.');
  }
  // Texting threads that went quiet: queue their after-call summary (singletonKey dedupes repeats).
  try {
    const before = new Date(now.getTime() - IDLE_SMS_HOURS * 3600_000);
    const companyIds = await companyIdsForRetention(deps.pools.system);
    for (const companyId of companyIds) {
      try {
        const ctx = { companyId, userId: null, role: 'system' as const, canApproveSpend: false };
        const ids = await withTenant(deps.pools, ctx, (tx) => listIdleSmsConversationIds(tx, ctx, before, IDLE_SMS_PER_COMPANY_LIMIT));
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

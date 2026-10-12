import { type TenantContext, zoneDayAfter, zoneDayStart } from '@roofline/db';
import { claimsGuard, guardSentence } from '@roofline/shared';
import { localParts } from './schedule.ts';

/** The one "written from a template" phrase; the first part of every summary that used a template. */
export const FROM_TEMPLATE = 'Written from a template';

/** The context the agent jobs run under. */
export function systemCtx(companyId: string): TenantContext {
  return { companyId, userId: null, role: 'system', canApproveSpend: false };
}

/** The instant on company-local day `today` (YYYY-MM-DD) whose wall clock reads `hour`:00, correct across clock changes. */
export function localTimeToday(today: string, hour: number, timeZone: string): Date {
  let t = zoneDayStart(today, timeZone).getTime() + hour * 3_600_000;
  // A day with a clock change is not 24 hours long; move to the wall-clock hour.
  const seen = localParts(new Date(t), timeZone).hour;
  t += (hour - seen) * 3_600_000;
  return new Date(t);
}

/**
 * When a plan made at `now` on company-local day `today` expires: `hour`:00 that day, or, when that time has
 * already passed (a Run now in the evening), the end of the local day, so a plan is never born expired.
 */
export function planExpiresAt(today: string, hour: number, timeZone: string, now: Date): Date {
  const at = localTimeToday(today, hour, timeZone);
  return at.getTime() > now.getTime() ? at : zoneDayStart(zoneDayAfter(today), timeZone);
}

/** Trimmed, non-empty, at most maxChars, every sentence clean under guardSentence, and claimsGuard ok. */
export function draftBodyOk(body: string, opts: { repName: string | null; maxChars: number }): boolean {
  const text = body.trim();
  if (text === '' || text.length > opts.maxChars) return false;
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== '');
  if (sentences.some((s) => guardSentence(s, { repName: opts.repName }).hits.length > 0)) return false;
  return claimsGuard(text).ok;
}

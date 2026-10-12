export type ScreenInput = { from: string; stirVerstat: string | null; blocked: boolean; callsLastHour: number; knownCustomer: boolean };

/** Reason strings stored on calls.spam_reason and returned by screenCall (spec Decision 13). */
export const SPAM_REASONS = { blocked: 'blocked_number', stir: 'stir_failed_repeat' } as const;

/** A caller whose STIR/SHAKEN attestation failed is rejected once it has called more than this many times in an hour. */
export const STIR_CALLS_PER_HOUR_LIMIT = 3;

/** STIR/SHAKEN verification failed: the exact value, or the value with an A/B/C attestation suffix. */
function stirFailed(stirVerstat: string | null): boolean {
  return stirVerstat !== null && (stirVerstat.startsWith('TN-Validation-Failed') || stirVerstat === 'No-TN-Validation');
}

/**
 * Pure screening rules, applied in this order (spec Decision 13):
 * 1. A number the company blocked is rejected, even when it belongs to a known customer.
 * 2. A known customer is never rejected by the STIR rule.
 * 3. A failed STIR/SHAKEN check from a caller with more than STIR_CALLS_PER_HOUR_LIMIT calls in the last hour is rejected.
 * callsLastHour includes the current call.
 */
export function screenCall(i: ScreenInput): { action: 'allow' | 'reject'; reason: string | null } {
  if (i.blocked === true) return { action: 'reject', reason: SPAM_REASONS.blocked };
  if (i.knownCustomer) return { action: 'allow', reason: null };
  if (stirFailed(i.stirVerstat) && i.callsLastHour > STIR_CALLS_PER_HOUR_LIMIT) {
    return { action: 'reject', reason: SPAM_REASONS.stir };
  }
  return { action: 'allow', reason: null };
}

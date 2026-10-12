import { AdPlatformError } from '../ads-google.ts';
import type { AdsMeta } from '../ads-meta.ts';
import type { MetaHttp } from './http.ts';

type Verified = Awaited<ReturnType<AdsMeta['verifyAccess']>>;

/** Meta account_status 1 means ACTIVE. */
const ACCOUNT_ACTIVE = 1;

/** Accepts 'act_123' or '123' and returns the Graph node path 'act_123'. */
export function adAccountPath(adAccountId: string): string {
  return `act_${adAccountId.replace(/^act_/, '')}`;
}

/**
 * True only for Graph errors that mean the account is not shared or the system user is not allowed on it:
 * code 100 with subcode 33 (unknown object for this token), code 10 (permission), or codes 200-299 (permission).
 * Rate limits, expired tokens, network failures and everything else are not access problems.
 */
function isAccessProblem(err: AdPlatformError): boolean {
  const code = err.graph?.code;
  if (code === undefined) return false;
  if (code === 100 && err.graph?.subcode === 33) return true;
  return code === 10 || (code >= 200 && code <= 299);
}

/**
 * Confirms the shared ad account is readable, active, and that the system user is assigned to it.
 * Permission and unknown-object Graph errors map to not_shared (account GET) or not_assigned (assignment).
 * Any other failure (rate limit, expired token, network) is rethrown so the caller treats it as transient.
 * Provider text is never returned; failures map to a plain reason.
 */
export async function verifyAccess(http: MetaHttp, adAccountId: string, systemUserId: string): Promise<Verified> {
  const path = adAccountPath(adAccountId);
  let account: { name?: unknown; currency?: unknown; account_status?: unknown };
  try {
    account = (await http.get(path, { fields: 'name,currency,account_status' })) as typeof account;
  } catch (err) {
    if (err instanceof AdPlatformError && isAccessProblem(err)) return { ok: false, reason: 'not_shared' };
    throw err;
  }
  if (account.account_status !== ACCOUNT_ACTIVE) return { ok: false, reason: 'disabled' };

  let assigned: unknown;
  try {
    assigned = await http.post(`${path}/assigned_users`, { user: systemUserId, tasks: ['ADVERTISE', 'ANALYZE'] });
  } catch (err) {
    if (err instanceof AdPlatformError && isAccessProblem(err)) return { ok: false, reason: 'not_assigned' };
    throw err;
  }
  if ((assigned as { success?: unknown } | null)?.success !== true) return { ok: false, reason: 'not_assigned' };
  return { ok: true, name: String(account.name ?? ''), currency: String(account.currency ?? '') };
}

import {
  audit,
  getAdAccount,
  getAdAccountByPlatform,
  updateAdAccount,
  upsertAdAccount,
  withTenant,
  type AdAccountRow,
  type TenantContext,
} from '@roofline/db';
import type { AdErrorKind } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, MESSAGES } from '../errors.ts';
import { reportJobError } from '../jobs/scheduler/report.ts';
import { AdPlatformError } from '../providers/ads-google.ts';

/*
 * Linking Google and Meta ad accounts. Provider text is never shown or stored: every failure becomes an
 * AdErrorKind and one of our own plain messages.
 */

export const AD_ERROR_MESSAGES: Record<AdErrorKind, string> = {
  access: "Roofline can't reach this ad account yet. Check the access you gave us.",
  payment: 'There is a payment problem on this ad account. Fix it in the ad platform.',
  policy: 'The ad platform blocked this account. Check its notices.',
  targeting: 'The ad platform rejected the settings on this account.',
  other: 'Something went wrong talking to the ad platform. Try again in a minute.',
};
export const GOOGLE_PENDING = 'Waiting for you to accept our invitation in Google Ads (Access and security).';
export const GOOGLE_REFUSED = 'The invitation was declined in Google Ads. Send it again to try once more.';
export const META_NOT_SHARED = 'Share your ad account with Roofline in Business Settings, then check again.';
export const META_NOT_ASSIGNED = 'Roofline can see the account but has no access to run ads. Give us access to it, then check again.';
export const META_DISABLED = 'This ad account is disabled by Meta.';
export const NOT_SET_UP = "Linking this ad platform isn't set up yet.";
export const BAD_GOOGLE_ID = 'Enter your 10-digit Google Ads customer ID.';
export const BAD_META_ID = 'Enter your Meta ad account ID (numbers, or act_ and numbers).';
export const ALREADY_LINKED = 'Remove the linked account first, then link a different one.';

/** What one live look at the platform says about an account (no database access). */
export type AdAccountEvaluation = {
  status: 'active' | 'pending' | 'error';
  name: string | null;
  currency: string | null;
  /** Our own plain sentence, or null when status is 'active'. */
  lastErrorPlain: string | null;
  /** True when the platform call threw (not a definite answer); the hourly recheck keeps the row pending. */
  fromThrow?: true;
};

/** '123-456-7890' or '1234567890' -> '1234567890'; anything else -> null. */
export function normalizeGoogleCustomerId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const digits = input.trim().replace(/-/g, '');
  return /^\d{10}$/.test(digits) ? digits : null;
}
/** 'act_123' or '123' (digits only after the optional act_) -> 'act_123'; anything else -> null. */
export function normalizeMetaAdAccountId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const rest = input.trim().replace(/^act_/i, '');
  return /^\d{5,20}$/.test(rest) ? `act_${rest}` : null;
}

function errorMessage(err: unknown): string {
  return err instanceof AdPlatformError ? AD_ERROR_MESSAGES[err.kind] : AD_ERROR_MESSAGES.other;
}
function failed(lastErrorPlain: string): AdAccountEvaluation {
  return { status: 'error', name: null, currency: null, lastErrorPlain };
}
function waiting(lastErrorPlain: string): AdAccountEvaluation {
  return { status: 'pending', name: null, currency: null, lastErrorPlain };
}

/**
 * One live look at the account on its platform, mapped to our statuses and plain messages.
 * Google: linkStatus 'active' -> accountInfo -> active; 'pending'/'none' -> pending; 'refused' -> error.
 * Meta: verifyAccess ok -> active; not_shared/not_assigned -> pending with a reason; disabled -> error.
 * An AdPlatformError (or any throw) -> status 'error' with the plain message for its kind, and fromThrow: true
 * (not a definite answer, so the hourly recheck keeps the row pending). Never throws.
 */
export async function evaluateAdAccount(deps: AppDeps, account: Pick<AdAccountRow, 'platform' | 'externalAccountId'>): Promise<AdAccountEvaluation> {
  const id = account.externalAccountId;
  try {
    if (account.platform === 'google') {
      if (!deps.adsGoogle.configured) return failed(NOT_SET_UP);
      const link = await deps.adsGoogle.linkStatus(id);
      if (link === 'active') {
        const info = await deps.adsGoogle.accountInfo(id);
        return { status: 'active', name: info.name, currency: info.currency, lastErrorPlain: null };
      }
      if (link === 'refused') return failed(GOOGLE_REFUSED);
      return waiting(GOOGLE_PENDING);
    }
    if (!deps.adsMeta.configured) return failed(NOT_SET_UP);
    const res = await deps.adsMeta.verifyAccess(id);
    if (res.ok) return { status: 'active', name: res.name, currency: res.currency, lastErrorPlain: null };
    if (res.reason === 'not_shared') return waiting(META_NOT_SHARED);
    if (res.reason === 'not_assigned') return waiting(META_NOT_ASSIGNED);
    return failed(META_DISABLED);
  } catch (err) {
    return { ...failed(errorMessage(err)), fromThrow: true };
  }
}

export type ConnectResult = { account: AdAccountRow; instructions?: { managerId: string } };

async function assertNotLinked(deps: AppDeps, ctx: TenantContext, platform: 'google' | 'meta'): Promise<void> {
  await withTenant(deps.pools, ctx, async (tx) => {
    const existing = await getAdAccountByPlatform(tx, ctx, platform);
    if (existing && existing.status !== 'revoked') throw new AppError(409, ALREADY_LINKED);
  });
}

async function store(
  deps: AppDeps,
  ctx: TenantContext,
  platform: 'google' | 'meta',
  externalAccountId: string,
  ev: AdAccountEvaluation,
  now: Date,
): Promise<AdAccountRow> {
  return withTenant(deps.pools, ctx, async (tx) => {
    // Re-check inside the writing transaction: a second request may have linked meanwhile.
    const existing = await getAdAccountByPlatform(tx, ctx, platform);
    if (existing && existing.status !== 'revoked') throw new AppError(409, ALREADY_LINKED);
    const row = await upsertAdAccount(tx, ctx, {
      platform,
      externalAccountId,
      status: ev.status,
      name: ev.name,
      currency: ev.currency,
      linkedAt: ev.status === 'active' ? now : null,
      lastErrorPlain: ev.lastErrorPlain,
      now,
    });
    await audit(tx, ctx, {
      action: 'ad_account.connect',
      targetType: 'ad_account',
      targetId: row.id,
      after: { platform, status: row.status },
      ip: null,
      at: now,
    });
    return row;
  });
}

export async function connectGoogleAccount(deps: AppDeps, ctx: TenantContext, customerId: string, now: Date): Promise<ConnectResult> {
  await assertNotLinked(deps, ctx, 'google');
  if (!deps.adsGoogle.configured) throw new AppError(503, NOT_SET_UP);
  let ev: AdAccountEvaluation;
  try {
    await deps.adsGoogle.invite(customerId);
    ev = await evaluateAdAccount(deps, { platform: 'google', externalAccountId: customerId });
  } catch (err) {
    ev = failed(errorMessage(err));
  }
  const account = await store(deps, ctx, 'google', customerId, ev, now);
  return { account, instructions: { managerId: deps.adsGoogle.managerId } };
}

export async function connectMetaAccount(deps: AppDeps, ctx: TenantContext, adAccountId: string, now: Date): Promise<ConnectResult> {
  await assertNotLinked(deps, ctx, 'meta');
  if (!deps.adsMeta.configured) throw new AppError(503, NOT_SET_UP);
  const ev = await evaluateAdAccount(deps, { platform: 'meta', externalAccountId: adAccountId });
  const account = await store(deps, ctx, 'meta', adAccountId, ev, now);
  return { account };
}

/**
 * The owner's on-demand check. For Google, re-sends the invitation when Google has none on record. A check that
 * throws (or hits a temporary error) keeps the account's previous status and only updates lastErrorPlain.
 */
export async function checkAdAccount(deps: AppDeps, ctx: TenantContext, id: string, now: Date): Promise<AdAccountRow> {
  const row = await withTenant(deps.pools, ctx, (tx) => getAdAccount(tx, ctx, id));
  if (!row) throw new AppError(404, MESSAGES.notFound);
  if (row.status === 'revoked') return row;
  let ev: AdAccountEvaluation;
  if (row.platform === 'google' && deps.adsGoogle.configured) {
    try {
      // No live invitation on Google's side: none on record (the first invite failed, or the link was removed),
      // or refused by the owner in Google Ads. invite() creates a fresh link in both cases, so send it again.
      const link = await deps.adsGoogle.linkStatus(row.externalAccountId);
      if (link === 'none' || link === 'refused') await deps.adsGoogle.invite(row.externalAccountId);
      ev = await evaluateAdAccount(deps, row);
    } catch (err) {
      ev = { ...failed(errorMessage(err)), fromThrow: true };
    }
  } else {
    ev = await evaluateAdAccount(deps, row);
  }
  // A thrown call is not a definite answer about the account: keep its status (and name and currency) and only
  // note the problem, so one temporary error cannot turn off the 95% spend guard for its campaigns.
  if (ev.fromThrow) {
    return withTenant(deps.pools, ctx, async (tx) => {
      const updated = await updateAdAccount(tx, ctx, id, { lastErrorPlain: ev.lastErrorPlain, now });
      if (!updated) throw new AppError(404, MESSAGES.notFound);
      return updated;
    });
  }
  return withTenant(deps.pools, ctx, async (tx) => {
    const updated = await updateAdAccount(tx, ctx, id, {
      status: ev.status,
      name: ev.name ?? undefined,
      currency: ev.currency ?? undefined,
      linkedAt: ev.status === 'active' && row.linkedAt === null ? now : undefined,
      lastErrorPlain: ev.lastErrorPlain,
      now,
    });
    if (!updated) throw new AppError(404, MESSAGES.notFound);
    return updated;
  });
}

export async function revokeAdAccount(deps: AppDeps, ctx: TenantContext, id: string, now: Date): Promise<AdAccountRow> {
  const existing = await withTenant(deps.pools, ctx, (tx) => getAdAccount(tx, ctx, id));
  if (!existing) throw new AppError(404, MESSAGES.notFound);
  if (existing.status === 'revoked') return existing;
  if (existing.platform === 'google') {
    // Outside any transaction. A platform failure never blocks the owner's removal and its text is dropped.
    try {
      await deps.adsGoogle.unlink(existing.externalAccountId);
    } catch (err) {
      reportJobError(deps, err, `ad-account revoke: unlink ${existing.id}`);
    }
  }
  return withTenant(deps.pools, ctx, async (tx) => {
    const row = await getAdAccount(tx, ctx, id);
    if (!row) throw new AppError(404, MESSAGES.notFound);
    if (row.status === 'revoked') return row;
    const updated = await updateAdAccount(tx, ctx, id, { status: 'revoked', lastErrorPlain: null, now });
    if (!updated) throw new AppError(404, MESSAGES.notFound);
    await audit(tx, ctx, {
      action: 'ad_account.revoke',
      targetType: 'ad_account',
      targetId: id,
      after: { platform: row.platform, status: 'revoked' },
      ip: null,
      at: now,
    });
    return updated;
  });
}

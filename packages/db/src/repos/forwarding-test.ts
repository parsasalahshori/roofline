import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { calls, companySettings } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * The forwarding test (D1 Task 17). It has no table of its own: a test is a calls row whose from_e164
 * is Roofline's test caller number and whose status is 'ringing' until the test call arrives (the
 * voice hook sets it 'ended' and stamps company_settings.forwarding_verified_at) or the 30 s job
 * fails it. All of it runs inside withTenant, so a query only sees the context's company.
 */

/** A test call counts as the pending one for this long after it was placed. */
export const FORWARDING_TEST_PENDING_MS = 60 * 1000;

export type ForwardingTestRecord = {
  id: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  /** company_settings.forwarding_verified_at is at or after this test's start. */
  verified: boolean;
};

/** Stores the test call as a calls row (status 'ringing', no conversation). The call sid is the one placeTestCall returned. */
export async function createForwardingTestCall(
  tx: Tx,
  ctx: TenantContext,
  i: { callSid: string; fromE164: string; toE164: string; now: Date },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(calls)
    .values({
      companyId: ctx.companyId,
      callSid: i.callSid,
      fromE164: i.fromE164,
      toE164: i.toE164,
      status: 'ringing',
      startedAt: i.now,
    })
    .returning({ id: calls.id });
  if (!row) throw new Error('The forwarding test row was not inserted.');
  return { id: row.id };
}

/** The test with this id, only when it was placed from `fromE164` (the test caller number); null for any other call. */
export async function getForwardingTest(tx: Tx, ctx: TenantContext, id: string, fromE164: string): Promise<ForwardingTestRecord | null> {
  const [row] = await tx
    .select({
      id: calls.id,
      status: calls.status,
      startedAt: calls.startedAt,
      endedAt: calls.endedAt,
      verified: sql<boolean>`coalesce(${companySettings.forwardingVerifiedAt} >= ${calls.startedAt}, false)`,
    })
    .from(calls)
    .leftJoin(companySettings, eq(companySettings.companyId, calls.companyId))
    .where(and(eq(calls.companyId, ctx.companyId), eq(calls.id, id), eq(calls.fromE164, fromE164)))
    .limit(1);
  if (!row) return null;
  return { ...row, verified: row.verified === true };
}

/** True when a test was placed from `fromE164` after `since` (the one-a-minute rate limit). */
export async function recentForwardingTestAt(tx: Tx, ctx: TenantContext, fromE164: string, since: Date): Promise<boolean> {
  const [row] = await tx
    .select({ id: calls.id })
    .from(calls)
    .where(and(eq(calls.companyId, ctx.companyId), eq(calls.fromE164, fromE164), gt(calls.startedAt, since)))
    .limit(1);
  return row !== undefined;
}

/**
 * Holds a transaction-scoped lock for this company's tests, so two starts at once cannot both pass the
 * rate limit. Released at commit or rollback.
 */
export async function lockForwardingTests(tx: Tx, ctx: TenantContext): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('forwarding-test:' || ${ctx.companyId}))`);
}

/** The newest test from `fromE164` that is still ringing and was placed within the pending window; null when none. */
export async function findPendingForwardingTest(
  tx: Tx,
  ctx: TenantContext,
  fromE164: string,
  now: Date,
): Promise<{ id: string; callSid: string } | null> {
  const [row] = await tx
    .select({ id: calls.id, callSid: calls.callSid })
    .from(calls)
    .where(
      and(
        eq(calls.companyId, ctx.companyId),
        eq(calls.fromE164, fromE164),
        eq(calls.status, 'ringing'),
        gt(calls.startedAt, new Date(now.getTime() - FORWARDING_TEST_PENDING_MS)),
      ),
    )
    .orderBy(desc(calls.startedAt))
    .limit(1);
  return row ?? null;
}

/**
 * The test call arrived: its row ends and the company's forwarding is marked verified now. The
 * company settings row is created when the company has none yet.
 */
export async function markForwardingVerified(tx: Tx, ctx: TenantContext, callSid: string, now: Date): Promise<void> {
  await tx
    .update(calls)
    .set({ status: 'ended', endedAt: now })
    .where(and(eq(calls.companyId, ctx.companyId), eq(calls.callSid, callSid)));
  await tx
    .insert(companySettings)
    .values({ companyId: ctx.companyId, forwardingVerifiedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: companySettings.companyId, set: { forwardingVerifiedAt: now, updatedAt: now } });
}

/** The 30 s timeout: a test still ringing becomes 'failed' (a test that already ended or arrived is left alone). */
export async function failForwardingTest(tx: Tx, ctx: TenantContext, id: string, now: Date): Promise<void> {
  await tx
    .update(calls)
    .set({ status: 'failed', endedAt: now })
    .where(and(eq(calls.companyId, ctx.companyId), eq(calls.id, id), eq(calls.status, 'ringing')));
}

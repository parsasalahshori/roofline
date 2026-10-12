import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { memberships, users } from '../schema/index.ts';

/*
 * The Front Desk transfer phone and on-call order (D1 Task 18), on the app_system pool because
 * app_tenant has no grant on memberships (Ruling DK). Only apps/api/src/account/transfer-phone.ts
 * imports this. Every write is scoped by company_id (and user_id for a person's own phone).
 */

/** One active member as the on-call list shows them. */
export type OnCallRow = {
  userId: string;
  name: string;
  onCallOrder: number | null;
  transferPhoneE164: string | null;
  recordingAckAt: Date | null;
};

/** Active members of the company: those on call first in ring order, then the rest by name. */
export async function listOnCallRows(system: Db, companyId: string): Promise<OnCallRow[]> {
  return system
    .select({
      userId: memberships.userId,
      name: users.name,
      onCallOrder: memberships.onCallOrder,
      transferPhoneE164: memberships.transferPhoneE164,
      recordingAckAt: memberships.recordingAckAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, companyId), eq(memberships.status, 'active')))
    .orderBy(sql`${memberships.onCallOrder} asc nulls last`, asc(users.name), asc(memberships.userId));
}

/**
 * Puts the listed users on the ring list in the order given (0, 1, 2, ...) and takes every other
 * member of the company off it. Only this company's memberships change. Ids that are not active
 * members of the company are ignored; the route checks them first.
 */
export async function setOnCallOrder(system: Db, companyId: string, userIds: string[]): Promise<void> {
  await system.transaction(async (tx) => {
    await tx
      .update(memberships)
      .set({ onCallOrder: null, updatedAt: new Date() })
      .where(eq(memberships.companyId, companyId));
    for (const [index, userId] of userIds.entries()) {
      await tx
        .update(memberships)
        .set({ onCallOrder: index, updatedAt: new Date() })
        .where(
          and(
            eq(memberships.companyId, companyId),
            eq(memberships.userId, userId),
            eq(memberships.status, 'active'),
            inArray(memberships.userId, userIds),
          ),
        );
    }
  });
}

export type TransferPhone = { e164: string | null; prefill: string | null; recordingAckAt: Date | null };

/** The member's saved transfer phone, their account phone to prefill with, and when they acknowledged recording. */
export async function getTransferPhone(system: Db, companyId: string, userId: string): Promise<TransferPhone> {
  const [row] = await system
    .select({ e164: memberships.transferPhoneE164, prefill: users.phoneE164, recordingAckAt: memberships.recordingAckAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, companyId), eq(memberships.userId, userId)))
    .limit(1);
  return row ?? { e164: null, prefill: null, recordingAckAt: null };
}

/** Saves the member's own transfer phone and the recording acknowledgement (now). Touches only that one membership. */
export async function saveTransferPhone(system: Db, companyId: string, userId: string, e164: string): Promise<TransferPhone> {
  const now = new Date();
  await system
    .update(memberships)
    .set({ transferPhoneE164: e164, recordingAckAt: now, updatedAt: now })
    .where(and(eq(memberships.companyId, companyId), eq(memberships.userId, userId)));
  return getTransferPhone(system, companyId, userId);
}

/** Active members on the ring list with their account email, in ring order (D1 Task 9: urgent message mail). */
export async function onCallEmails(system: Db, companyId: string): Promise<{ userId: string; email: string }[]> {
  return system
    .select({ userId: memberships.userId, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, companyId), eq(memberships.status, 'active'), sql`${memberships.onCallOrder} is not null`))
    .orderBy(asc(memberships.onCallOrder), asc(memberships.userId));
}

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ConsentStatus } from '@roofline/shared';
import { customers, optOuts } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { addActivity } from './activities.ts';
import { audit } from './audit.ts';
import { customersWithPhone, lockRecipients } from './inbound.ts';

/*
 * Carrier opt-outs (spec 4.5): the texting service refused a text to this number because the person
 * turned off texts from our number. The send path calls this in the same transaction as the failed
 * text, so the number goes on the opt-out list and every customer who has it stops being texted.
 */

/** What the timeline says when the texting service reports an opt-out. */
export const CARRIER_OPT_OUT = 'The texting service says this person opted out. Texting is turned off.';

/** The keyword the opt-out list records for a carrier opt-out. */
const CARRIER_KEYWORD = 'carrier';

type ConsentRow = { id: string; smsConsentStatus: ConsentStatus; smsConsentSource: string | null; smsConsentAt: Date | null; smsConsentByUserId: string | null };

/** The consent columns as plain JSON for the audit log. */
function consentSnapshot(row: ConsentRow): Record<string, unknown> {
  return {
    smsConsentStatus: row.smsConsentStatus,
    smsConsentSource: row.smsConsentSource,
    smsConsentAt: row.smsConsentAt?.toISOString() ?? null,
    smsConsentByUserId: row.smsConsentByUserId,
  };
}

/**
 * Records that the texting service refused `phoneE164` because the person opted out. Locks every
 * customer with the number (archived ones too) and their consent rows first, the same order as
 * `revokeConsentByText`, then:
 * - puts the number on the opt-out list with keyword `carrier`; a row already there (a STOP from the
 *   customer) keeps its own keyword and time;
 * - sets every customer who is not already `revoked` to `revoked`, source `text`, now, by nobody,
 *   each with a `customer.consent_revoked` audit row (`after.via` = `carrier`) and a timeline line.
 * Returns the ids of the customers it revoked (empty when none has the number or none needed it).
 */
export async function recordCarrierOptOut(tx: Tx, ctx: TenantContext, phoneE164: string, now: Date): Promise<string[]> {
  const found = await customersWithPhone(tx, ctx, phoneE164);
  const ids = found.map((c) => c.id);
  await lockRecipients(tx, ctx, ids);

  const before: ConsentRow[] =
    ids.length === 0
      ? []
      : await tx
          .select({
            id: customers.id,
            smsConsentStatus: customers.smsConsentStatus,
            smsConsentSource: customers.smsConsentSource,
            smsConsentAt: customers.smsConsentAt,
            smsConsentByUserId: customers.smsConsentByUserId,
          })
          .from(customers)
          .where(
            and(
              eq(customers.companyId, ctx.companyId),
              inArray(customers.id, ids),
            ),
          )
          .orderBy(asc(customers.id))
          .for('update');

  await tx
    .insert(optOuts)
    .values({ companyId: ctx.companyId, phoneE164, keyword: CARRIER_KEYWORD, at: now, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: [optOuts.companyId, optOuts.phoneE164] });

  const toRevoke = before.filter((c) => c.smsConsentStatus !== 'revoked');
  if (toRevoke.length === 0) return [];

  const after = await tx
    .update(customers)
    .set({ smsConsentStatus: 'revoked', smsConsentSource: 'text', smsConsentAt: now, smsConsentByUserId: null, updatedAt: now })
    .where(
      and(
        eq(customers.companyId, ctx.companyId),
        inArray(customers.id, toRevoke.map((c) => c.id)),
      ),
    )
    .returning({
      id: customers.id,
      smsConsentStatus: customers.smsConsentStatus,
      smsConsentSource: customers.smsConsentSource,
      smsConsentAt: customers.smsConsentAt,
      smsConsentByUserId: customers.smsConsentByUserId,
    });
  const afterById = new Map(after.map((row) => [row.id, row]));

  for (const was of toRevoke) {
    const row = afterById.get(was.id)!;
    await audit(tx, ctx, {
      action: 'customer.consent_revoked',
      targetType: 'customer',
      targetId: was.id,
      before: consentSnapshot(was),
      after: { ...consentSnapshot(row), via: 'carrier' },
      at: now,
    });
    await addActivity(tx, ctx, {
      subjectType: 'customer',
      subjectId: was.id,
      kind: 'customer.consent_changed',
      summary: CARRIER_OPT_OUT,
      data: { from: was.smsConsentStatus, to: 'revoked', via: 'carrier' },
      at: now,
    });
  }
  return toRevoke.map((c) => c.id);
}

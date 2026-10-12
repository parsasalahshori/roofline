import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { customers, properties } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * D1 Task 7 shell (lead). Signatures are fixed; Builder 1 fills the bodies of the first three,
 * and keeps the two Ruling DZ stubs returning [] / null with their TODO comments.
 */

export type CallerMatch = { customerId: string; name: string };
export type CallerProperty = { id: string; street: string; lat: number | null; lng: number | null };
export type HailHit = { propertyId: string; occurredOn: string; hailSizeInches: number | null };

/** Lowercase, punctuation removed, whitespace collapsed. */
function norm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Customers of ctx.companyId whose phones contain this E.164 number. */
export async function matchCustomersByPhone(tx: Tx, ctx: TenantContext, phoneE164: string): Promise<CallerMatch[]> {
  const rows = await tx
    .select({ id: customers.id, name: customers.displayName })
    .from(customers)
    .where(
      and(
        eq(customers.companyId, ctx.companyId),
        isNull(customers.archivedAt),
        sql`${customers.phones} @> ${JSON.stringify([{ e164: phoneE164 }])}::jsonb`,
      ),
    )
    .orderBy(asc(customers.createdAt), asc(customers.id));
  return rows.map((r) => ({ customerId: r.id, name: r.name }));
}

/** True when `name` matches the customer (case/space-insensitive) and `street` matches one of their non-archived properties. */
export async function verifyCustomerByNameStreet(
  tx: Tx,
  ctx: TenantContext,
  customerId: string,
  name: string,
  street: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ displayName: customers.displayName, firstName: customers.firstName, lastName: customers.lastName })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, customerId), isNull(customers.archivedAt)));
  if (!row) return false;
  const given = norm(name);
  if (given === '') return false;
  const accepted = [row.displayName, [row.firstName, row.lastName].filter((x) => x !== null && x !== '').join(' ')].map(norm);
  if (!accepted.includes(given)) return false;
  const wanted = norm(street);
  if (wanted === '') return false;
  const props = await propertiesForCustomer(tx, ctx, customerId);
  return props.some((p) => norm(p.street) === wanted);
}

/** A customer's non-archived properties (id, street, lat, lng). */
export async function propertiesForCustomer(tx: Tx, ctx: TenantContext, customerId: string): Promise<CallerProperty[]> {
  const rows = await tx
    .select({ id: properties.id, street: properties.addressLine, geom: properties.geom })
    .from(properties)
    .where(and(eq(properties.companyId, ctx.companyId), eq(properties.customerId, customerId), isNull(properties.archivedAt)))
    .orderBy(asc(properties.createdAt), asc(properties.id));
  return rows.map((r) => ({ id: r.id, street: r.street, lat: r.geom ? r.geom[1] : null, lng: r.geom ? r.geom[0] : null }));
}

// TODO(S1 T9): replace with a read of storm_hits once s1-storm is merged.
/* eslint-disable @typescript-eslint/no-unused-vars -- Ruling DZ stubs keep their final signatures */
export async function hailHitsForProperties(_tx: Tx, _ctx: TenantContext, _propertyIds: string[], _sinceDays: number): Promise<HailHit[]> {
  return [];
}

// TODO(E1 T8): replace with a read of proposals/proposal_events once e1-estimator is merged.
export async function proposalStatusForJob(_tx: Tx, _ctx: TenantContext, _jobId: string): Promise<'sent' | 'viewed' | 'signed' | null> {
  return null;
}
/* eslint-enable @typescript-eslint/no-unused-vars */

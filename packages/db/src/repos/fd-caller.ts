import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { companyStorms, customers, properties, proposals, stormHits, storms } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * Front Desk caller lookups (D1 Task 7). hailHitsForProperties reads S1's storm_hits and
 * proposalStatusForJob reads E1's proposals (the Ruling DZ stubs, filled once both merged).
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

const DAY_MS = 86_400_000;

/**
 * Storm hits on these properties (of ctx.companyId) whose storm's convective day is within the last
 * `sinceDays` days (UTC), newest first. One row per property and storm; merged storms are skipped
 * because the older storm they joined carries the hit. Hail size is the radar estimate over the home.
 */
export async function hailHitsForProperties(
  tx: Tx,
  ctx: TenantContext,
  propertyIds: string[],
  sinceDays: number,
  now: Date = new Date(),
): Promise<HailHit[]> {
  if (propertyIds.length === 0) return [];
  const since = new Date(now.getTime() - sinceDays * DAY_MS).toISOString().slice(0, 10);
  const rows = await tx
    .select({ propertyId: stormHits.propertyId, occurredOn: storms.convectiveDay, hailIn: stormHits.hailIn })
    .from(stormHits)
    .innerJoin(companyStorms, and(eq(companyStorms.companyId, stormHits.companyId), eq(companyStorms.id, stormHits.companyStormId)))
    .innerJoin(storms, eq(storms.id, companyStorms.stormId))
    .where(
      and(
        eq(stormHits.companyId, ctx.companyId),
        inArray(stormHits.propertyId, propertyIds),
        isNull(storms.mergedInto),
        gte(storms.convectiveDay, since),
      ),
    )
    .orderBy(desc(storms.convectiveDay), asc(stormHits.propertyId));
  return rows.map((r) => ({ propertyId: r.propertyId, occurredOn: r.occurredOn, hailSizeInches: r.hailIn }));
}

/**
 * Where the job's proposal stands for the homeowner: 'signed' when any of its proposals is signed,
 * otherwise 'viewed' or 'sent' for its newest open proposal that has not passed its valid-until date
 * (UTC). Null when nothing has gone out yet, or what went out was declined, expired or replaced.
 */
export async function proposalStatusForJob(
  tx: Tx,
  ctx: TenantContext,
  jobId: string,
  now: Date = new Date(),
): Promise<'sent' | 'viewed' | 'signed' | null> {
  const rows = await tx
    .select({ status: proposals.status, validUntil: proposals.validUntil })
    .from(proposals)
    .where(and(eq(proposals.companyId, ctx.companyId), eq(proposals.jobId, jobId), inArray(proposals.status, ['sent', 'viewed', 'signed'])))
    .orderBy(desc(proposals.sentAt), desc(proposals.createdAt));
  if (rows.some((r) => r.status === 'signed')) return 'signed';
  const today = now.toISOString().slice(0, 10);
  const open = rows.find((r) => r.validUntil >= today);
  return open ? (open.status as 'sent' | 'viewed') : null;
}

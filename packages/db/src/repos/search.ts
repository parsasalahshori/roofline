import { and, asc, desc, eq, ilike, isNull, or, type SQL, sql } from 'drizzle-orm';
import { JOB_STAGE_LABELS, type JobStage } from '@roofline/shared';
import { customers, jobs, properties } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { customerScope, jobScope, propertyScope } from './scope.ts';

/** Escapes the characters LIKE treats as wildcards, so a search for `100%` finds "100%". */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** A customer in the search box: the primary phone is in E.164, or null when there is none. */
export type SearchCustomer = { id: string; displayName: string; phone: string | null };

export type SearchJob = {
  id: string;
  stage: JobStage;
  stageLabel: string;
  customerId: string;
  customerName: string;
  propertyId: string | null;
  addressLine: string | null;
};

export type SearchAddress = {
  id: string;
  addressLine: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  customerId: string;
  customerName: string;
};

/**
 * The customer match shared by `listCustomers` and `searchAll`: the name contains the text (any case), or, when the text has
 * three or more digits, one of the customer's numbers contains those digits.
 */
export function customerMatch(q: string): SQL | undefined {
  const byName = ilike(customers.displayName, `%${escapeLike(q)}%`);
  const digits = q.replace(/\D/g, '');
  if (digits.length < 3) return byName;
  return or(
    byName,
    sql`exists (
      select 1 from jsonb_array_elements(${customers.phones}) as phone(entry)
      where regexp_replace(phone.entry->>'e164', '[^0-9]', '', 'g') like ${`%${digits}%`}
    )`,
  );
}

/**
 * The top-bar search: up to `limit` matches in each of three lists, for what the member may see.
 * The caller has already trimmed `q`, cut it to its longest allowed length and refused one that is
 * too short to be useful.
 * - customers: as `listCustomers` (name, or phone digits); by name.
 * - addresses: the street, city or ZIP; only addresses with a customer who is not archived; by street.
 * - jobs: the customer's name or the street of the job's address; newest first; jobs of an archived customer are left out too.
 * Archived records are left out, and a rep sees only what the scope helpers let through.
 */
export async function searchAll(
  tx: Tx,
  ctx: TenantContext,
  q: string,
  limit: number,
): Promise<{ customers: SearchCustomer[]; jobs: SearchJob[]; addresses: SearchAddress[] }> {
  const like = `%${escapeLike(q)}%`;

  const customerRows = await tx
    .select({ id: customers.id, displayName: customers.displayName, phones: customers.phones })
    .from(customers)
    .where(and(isNull(customers.archivedAt), customerScope(ctx), customerMatch(q)))
    .orderBy(asc(sql`lower(${customers.displayName})`), asc(customers.createdAt), asc(customers.id))
    .limit(limit);

  const addressRows = await tx
    .select({
      id: properties.id,
      addressLine: properties.addressLine,
      city: properties.city,
      state: properties.state,
      zip: properties.zip,
      customerId: customers.id,
      customerName: customers.displayName,
    })
    .from(properties)
    .innerJoin(customers, eq(properties.customerId, customers.id))
    .where(
      and(
        isNull(properties.archivedAt),
        isNull(customers.archivedAt),
        propertyScope(ctx),
        customerScope(ctx),
        or(ilike(properties.addressLine, like), ilike(properties.city, like), ilike(properties.zip, like)),
      ),
    )
    .orderBy(asc(sql`lower(${properties.addressLine})`), asc(properties.createdAt), asc(properties.id))
    .limit(limit);

  const jobRows = await tx
    .select({
      id: jobs.id,
      stage: jobs.stage,
      customerId: jobs.customerId,
      customerName: customers.displayName,
      propertyId: jobs.propertyId,
      addressLine: properties.addressLine,
    })
    .from(jobs)
    .innerJoin(customers, eq(jobs.customerId, customers.id))
    .leftJoin(properties, eq(jobs.propertyId, properties.id))
    .where(
      and(
        isNull(jobs.archivedAt),
        isNull(customers.archivedAt),
        jobScope(ctx),
        or(ilike(customers.displayName, like), ilike(properties.addressLine, like)),
      ),
    )
    .orderBy(desc(jobs.createdAt), asc(jobs.id))
    .limit(limit);

  return {
    customers: customerRows.map((row) => {
      const primary = row.phones.find((phone) => phone.primary === true) ?? row.phones[0];
      return { id: row.id, displayName: row.displayName, phone: primary?.e164 ?? null };
    }),
    jobs: jobRows.map((row) => ({ ...row, stageLabel: JOB_STAGE_LABELS[row.stage] })),
    addresses: addressRows,
  };
}

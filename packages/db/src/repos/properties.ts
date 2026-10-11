import { and, asc, count, eq, ilike, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { normalizeAddressKey } from '@roofline/shared';
import { findPgError, isUniqueViolation } from '../errors.ts';
import { companies, jobs, properties } from '../schema/index.ts';
import type { LngLat } from '../schema/columns.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { addActivity } from './activities.ts';
import { audit } from './audit.ts';
import { getCustomer, type WriteOptions } from './customers.ts';
import { clampPage } from './paging.ts';
import { propertyScope } from './scope.ts';
import { escapeLike } from './search.ts';

export type PropertyRow = typeof properties.$inferSelect;

/**
 * A new address. The caller (the API route) has already checked and normalized the values: the
 * state is two capital letters, the ZIP five digits, the time zone a real one, the year in range.
 */
export type PropertyInput = {
  /** A customer the member can see. Null or left out: no customer yet (a home in a storm path). */
  customerId?: string | null;
  addressLine: string;
  city: string;
  state: string;
  zip: string;
  /** `[longitude, latitude]`. */
  location?: LngLat | null;
  /** Left out: the company's own time zone. */
  timezone?: string;
  yearBuilt?: number | null;
};

/** Changes to an address. A field left out (undefined) is not touched; null clears the ones that can be cleared. */
export type PropertyPatch = {
  customerId?: string | null;
  addressLine?: string;
  city?: string;
  state?: string;
  zip?: string;
  /** Null takes the pin off the map. */
  location?: LngLat | null;
  timezone?: string;
  yearBuilt?: number | null;
};

/** The company already has an address with this key (same street, same ZIP, however it was written). */
export class DuplicateAddressError extends Error {
  constructor() {
    super('This company already has that address.');
    this.name = 'DuplicateAddressError';
  }
}

/** The customer named for an address is not one the member can see (or does not exist). */
export class UnknownCustomerError extends Error {
  constructor() {
    super('That customer does not exist, or the member cannot see it.');
    this.name = 'UnknownCustomerError';
  }
}

/** A rep saved or edited an address without a customer. Reps tie every address to a customer they can see. */
export class CustomerRequiredError extends Error {
  constructor() {
    super('A rep must give a customer for the address.');
    this.name = 'CustomerRequiredError';
  }
}

/** The address has live (not archived) jobs for a customer other than the one it was being given to. */
export class AddressHasJobsError extends Error {
  constructor() {
    super('That address already has jobs for a different customer.');
    this.name = 'AddressHasJobsError';
  }
}

const ADDRESS_KEY_CONSTRAINT = 'properties_company_address_key_uniq';
const CUSTOMER_CONSTRAINT = 'properties_company_customer_fk';

/**
 * Runs a write on `properties`. The unique key on `(company_id, address_key)` failing becomes
 * `DuplicateAddressError`; the same-company customer key failing (the customer vanished between the
 * check and the write) becomes `UnknownCustomerError`: the last line of defence behind the checks.
 */
async function writing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isUniqueViolation(err, ADDRESS_KEY_CONSTRAINT)) throw new DuplicateAddressError();
    const pg = findPgError(err);
    if (pg?.code === '23503' && pg.constraint === CUSTOMER_CONSTRAINT) throw new UnknownCustomerError();
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// History helpers

const AUDITED = ['customerId', 'addressLine', 'city', 'state', 'zip', 'lat', 'lng', 'timezone', 'yearBuilt'] as const;
type AuditedField = (typeof AUDITED)[number];

/** The named fields of an address as plain JSON for the audit log (`lat` and `lng` come out of the point). */
function snapshot(row: PropertyRow, fields: readonly AuditedField[]): Record<string, unknown> {
  const values: Record<AuditedField, unknown> = {
    customerId: row.customerId,
    addressLine: row.addressLine,
    city: row.city,
    state: row.state,
    zip: row.zip,
    lat: row.geom?.[1] ?? null,
    lng: row.geom?.[0] ?? null,
    timezone: row.timezone,
    yearBuilt: row.yearBuilt,
  };
  return Object.fromEntries(fields.map((field) => [field, values[field]]));
}

async function companyTimezone(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  return row!.timezone;
}

// ---------------------------------------------------------------------------------------------
// Reads

/** One address the member may see, or null (it does not exist, is another company's, or is outside a rep's scope). */
export async function getProperty(tx: Tx, ctx: TenantContext, id: string): Promise<PropertyRow | null> {
  const [row] = await tx
    .select()
    .from(properties)
    .where(and(eq(properties.id, id), propertyScope(ctx)))
    .limit(1);
  return row ?? null;
}

export type ListPropertiesOptions = {
  /** Matches the street address, the city or the ZIP (any part, any case). */
  q?: string;
  /** Only this customer's addresses. */
  customerId?: string;
  /** Default 50, at most 200. */
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
};

/** The addresses the member may see, by street address, with the count before paging. */
export async function listProperties(
  tx: Tx,
  ctx: TenantContext,
  options: ListPropertiesOptions = {},
): Promise<{ properties: PropertyRow[]; total: number }> {
  const { limit, offset } = clampPage(options);
  const conditions: (SQL | undefined)[] = [propertyScope(ctx)];
  if (options.includeArchived !== true) conditions.push(isNull(properties.archivedAt));
  if (options.customerId !== undefined) conditions.push(eq(properties.customerId, options.customerId));

  const q = options.q?.trim() ?? '';
  if (q !== '') {
    const like = `%${escapeLike(q)}%`;
    conditions.push(or(ilike(properties.addressLine, like), ilike(properties.city, like), ilike(properties.zip, like)));
  }

  const where = and(...conditions);
  const rows = await tx
    .select()
    .from(properties)
    .where(where)
    .orderBy(asc(sql`lower(${properties.addressLine})`), asc(properties.createdAt), asc(properties.id))
    .limit(limit)
    .offset(offset);
  const [totals] = await tx.select({ total: count() }).from(properties).where(where);
  return { properties: rows, total: totals?.total ?? 0 };
}

// ---------------------------------------------------------------------------------------------
// Writes

/**
 * Adds an address. Throws `CustomerRequiredError` when a rep gives no customer (an address a rep
 * saves with no customer would be out of their own sight: owner, office and system may leave it
 * out), `UnknownCustomerError` when `customerId` is not a customer the member can
 * see, and `DuplicateAddressError` when the company already has this street address in this ZIP
 * (the key is `normalizeAddressKey`, so punctuation, case and spacing do not make a new address).
 * Writes the audit row and the "Address added" timeline line.
 */
export async function createProperty(
  tx: Tx,
  ctx: TenantContext,
  input: PropertyInput,
  options: WriteOptions,
): Promise<PropertyRow> {
  const { now } = options;
  if (ctx.role === 'rep' && input.customerId == null) throw new CustomerRequiredError();
  if (input.customerId != null && !(await getCustomer(tx, ctx, input.customerId))) throw new UnknownCustomerError();
  const timezone = input.timezone ?? (await companyTimezone(tx, ctx));

  const [row] = await writing(() =>
    tx
      .insert(properties)
      .values({
        companyId: ctx.companyId,
        customerId: input.customerId ?? null,
        addressLine: input.addressLine,
        city: input.city,
        state: input.state,
        zip: input.zip,
        addressKey: normalizeAddressKey(input.addressLine, input.zip),
        ...(input.location != null && { geom: input.location }),
        timezone,
        yearBuilt: input.yearBuilt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning(),
  );
  const created = row!;

  await audit(tx, ctx, {
    action: 'property.create',
    targetType: 'property',
    targetId: created.id,
    after: snapshot(created, AUDITED),
    ip: options.ip ?? null,
    at: now,
  });
  await addActivity(tx, ctx, {
    subjectType: 'property',
    subjectId: created.id,
    kind: 'property.created',
    summary: 'Address added',
    at: now,
  });
  return created;
}

/**
 * Changes an address the member may see; null when they may not (or it does not exist). The row is
 * locked for the length of the transaction. A new `customerId` (other than the one it has) must be a
 * customer the member can see (`UnknownCustomerError`), and the address may have no live job for any
 * other customer (`AddressHasJobsError`; archived jobs do not count, and clearing the customer is
 * always consistent with the jobs). A rep cannot clear the customer (`CustomerRequiredError`). A new
 * street address or ZIP gives the
 * address a new key, which may clash with another address (`DuplicateAddressError`).
 * Always writes the audit row (the fields the patch named, before and after) and an "Address
 * details updated" line.
 */
export async function updateProperty(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  patch: PropertyPatch,
  options: WriteOptions,
): Promise<PropertyRow | null> {
  const { now } = options;
  const [before] = await tx
    .select()
    .from(properties)
    .where(and(eq(properties.id, id), propertyScope(ctx)))
    .limit(1)
    .for('update');
  if (!before) return null;

  const set: Partial<typeof properties.$inferInsert> = { updatedAt: now };
  const touched = new Set<AuditedField>();

  if (patch.customerId !== undefined) {
    if (patch.customerId === null && ctx.role === 'rep') throw new CustomerRequiredError();
    if (patch.customerId !== null && patch.customerId !== before.customerId) {
      if (!(await getCustomer(tx, ctx, patch.customerId))) throw new UnknownCustomerError();
      // Every live job at this address must be for the customer it is being given to. All of the
      // company's jobs count, not only the ones this member may see.
      const [other] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.propertyId, id), isNull(jobs.archivedAt), ne(jobs.customerId, patch.customerId)))
        .limit(1);
      if (other) throw new AddressHasJobsError();
    }
    set.customerId = patch.customerId;
    touched.add('customerId');
  }
  if (patch.addressLine !== undefined) {
    set.addressLine = patch.addressLine;
    touched.add('addressLine');
  }
  if (patch.city !== undefined) {
    set.city = patch.city;
    touched.add('city');
  }
  if (patch.state !== undefined) {
    set.state = patch.state;
    touched.add('state');
  }
  if (patch.zip !== undefined) {
    set.zip = patch.zip;
    touched.add('zip');
  }
  if (patch.addressLine !== undefined || patch.zip !== undefined) {
    set.addressKey = normalizeAddressKey(patch.addressLine ?? before.addressLine, patch.zip ?? before.zip);
  }
  if (patch.location !== undefined) {
    set.geom = patch.location;
    touched.add('lat');
    touched.add('lng');
  }
  if (patch.timezone !== undefined) {
    set.timezone = patch.timezone;
    touched.add('timezone');
  }
  if (patch.yearBuilt !== undefined) {
    set.yearBuilt = patch.yearBuilt;
    touched.add('yearBuilt');
  }

  const [updated] = await writing(() => tx.update(properties).set(set).where(eq(properties.id, id)).returning());
  const after = updated!;

  const fields = AUDITED.filter((field) => touched.has(field));
  await audit(tx, ctx, {
    action: 'property.update',
    targetType: 'property',
    targetId: id,
    before: snapshot(before, fields),
    after: snapshot(after, fields),
    ip: options.ip ?? null,
    at: now,
  });
  await addActivity(tx, ctx, {
    subjectType: 'property',
    subjectId: id,
    kind: 'property.updated',
    summary: 'Address details updated',
    data: { fields },
    at: now,
  });
  return after;
}

/**
 * Archives or restores an address the member may see (null when they may not). There is no hard
 * delete, and an archived address keeps its key, so it cannot be added a second time: it is
 * restored instead. Doing it again changes nothing and writes nothing.
 */
export async function setPropertyArchived(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  archived: boolean,
  options: WriteOptions,
): Promise<PropertyRow | null> {
  const { now } = options;
  const [before] = await tx
    .select()
    .from(properties)
    .where(and(eq(properties.id, id), propertyScope(ctx)))
    .limit(1)
    .for('update');
  if (!before) return null;
  if (archived === (before.archivedAt !== null)) return before;

  const [updated] = await tx
    .update(properties)
    .set({ archivedAt: archived ? now : null, updatedAt: now })
    .where(eq(properties.id, id))
    .returning();
  const after = updated!;

  await audit(tx, ctx, {
    action: archived ? 'property.archive' : 'property.unarchive',
    targetType: 'property',
    targetId: id,
    before: { archivedAt: before.archivedAt?.toISOString() ?? null },
    after: { archivedAt: after.archivedAt?.toISOString() ?? null },
    ip: options.ip ?? null,
    at: now,
  });
  await addActivity(tx, ctx, {
    subjectType: 'property',
    subjectId: id,
    kind: archived ? 'property.archived' : 'property.unarchived',
    summary: archived ? 'Address archived' : 'Address restored',
    at: now,
  });
  return after;
}

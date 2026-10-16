import { and, eq, sql } from 'drizzle-orm';
import { isTimeZone } from '@roofline/shared';
import { companies, customers, properties } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { addActivity } from './activities.ts';
import { audit } from './audit.ts';

/*
 * The pieces every signed-out web request that becomes a lead shares (the storm landing page, the instant quote
 * page): find or add the customer for a phone, and the address the job goes to, without ever handing one company's
 * customer to another or naming another customer back to the requester. Moved here from storm-requests.ts unchanged
 * apart from the optional first/last name and email a new customer may get.
 */

/** Who asked and for which home. The geocoded parts are required: a request without them is refused earlier. */
export type WebLeadInput = {
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phoneE164: string;
  property: { addressLine: string; city: string; state: string; zip: string; location: [number, number] | null; timezone: string | null };
};

type CustomerRow = typeof customers.$inferSelect;

/** Takes a transaction-scoped advisory lock with the same key shape customers.ts uses for phones. */
export async function lockWebLead(tx: Tx, companyId: string, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${companyId}::text || ':' || ${key}::text, 0))`);
}

/** The company's time zone, or UTC when it is missing or not a zone the platform knows. */
export async function webLeadZone(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  return row && isTimeZone(row.timezone) ? row.timezone : 'UTC';
}

/**
 * The customer for this phone: an active one of the company that has the number, reused with its
 * consent untouched; or a new 'web' customer at consent 'none'.
 */
export async function phoneCustomerFor(tx: Tx, ctx: TenantContext, input: WebLeadInput, now: Date): Promise<CustomerRow> {
  await lockWebLead(tx, ctx.companyId, input.phoneE164);
  const [found] = await tx
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.companyId, ctx.companyId),
        sql`${customers.archivedAt} is null`,
        sql`${customers.phones} @> ${JSON.stringify([{ e164: input.phoneE164 }])}::jsonb`,
      ),
    )
    .limit(1);
  if (found) return found;

  const [created] = await tx
    .insert(customers)
    .values({
      companyId: ctx.companyId,
      displayName: input.name,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      phones: [{ e164: input.phoneE164, primary: true }],
      emails: input.email ? [input.email] : [],
      tags: [],
      doNotContact: false,
      smsConsentStatus: 'none',
      source: 'web',
      createdByUserId: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const row = created!;

  await audit(tx, ctx, {
    action: 'customer.create',
    targetType: 'customer',
    targetId: row.id,
    after: { displayName: row.displayName, phones: row.phones, smsConsentStatus: row.smsConsentStatus },
    ip: null,
    at: now,
  });
  await addActivity(tx, ctx, { subjectType: 'customer', subjectId: row.id, kind: 'customer.created', summary: 'Customer added', at: now });
  return row;
}

/**
 * The customer the job goes to and the address row for it. See the note on `createStormRequest`
 * step 4: a reused address keeps its owner; an unowned one is taken by the phone customer.
 */
export async function addressCustomerFor(tx: Tx, ctx: TenantContext, addressKey: string, phoneCustomer: CustomerRow): Promise<CustomerRow> {
  const existing = await addressRowByKey(tx, ctx, addressKey);
  if (!existing || existing.customerId === null || existing.customerId === phoneCustomer.id) return phoneCustomer;

  const [owner] = await tx.select().from(customers).where(eq(customers.id, existing.customerId)).limit(1);
  return owner ?? phoneCustomer;
}

export type AddressRow = typeof properties.$inferSelect;

export async function addressRowByKey(tx: Tx, ctx: TenantContext, addressKey: string): Promise<AddressRow | null> {
  const [row] = await tx
    .select()
    .from(properties)
    .where(and(eq(properties.companyId, ctx.companyId), eq(properties.addressKey, addressKey)))
    .limit(1);
  return row ?? null;
}

/** The address row for the job: the existing one (taking the customer when it had none) or a new one for the customer. */
export async function addressRowFor(
  tx: Tx,
  ctx: TenantContext,
  input: WebLeadInput,
  addressKey: string,
  jobCustomer: CustomerRow,
  now: Date,
): Promise<AddressRow> {
  const existing = await addressRowByKey(tx, ctx, addressKey);
  if (existing) {
    if (existing.customerId !== null) return existing;
    const [claimed] = await tx
      .update(properties)
      .set({ customerId: jobCustomer.id, updatedAt: now })
      .where(eq(properties.id, existing.id))
      .returning();
    await audit(tx, ctx, {
      action: 'property.update',
      targetType: 'property',
      targetId: existing.id,
      before: { customerId: null },
      after: { customerId: jobCustomer.id },
      ip: null,
      at: now,
    });
    await addActivity(tx, ctx, {
      subjectType: 'property',
      subjectId: existing.id,
      kind: 'property.updated',
      summary: `Address linked to ${jobCustomer.displayName}`,
      data: { fields: ['customerId'], customerId: jobCustomer.id },
      at: now,
    });
    return claimed!;
  }

  const [row] = await tx
    .insert(properties)
    .values({
      companyId: ctx.companyId,
      customerId: jobCustomer.id,
      addressLine: input.property.addressLine,
      city: input.property.city,
      state: input.property.state,
      zip: input.property.zip,
      addressKey,
      ...(input.property.location !== null && { geom: input.property.location }),
      timezone: input.property.timezone !== null && isTimeZone(input.property.timezone) ? input.property.timezone : null,
      yearBuilt: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const created = row!;

  await audit(tx, ctx, {
    action: 'property.create',
    targetType: 'property',
    targetId: created.id,
    after: { customerId: created.customerId, addressLine: created.addressLine, city: created.city, state: created.state, zip: created.zip },
    ip: null,
    at: now,
  });
  await addActivity(tx, ctx, { subjectType: 'property', subjectId: created.id, kind: 'property.created', summary: 'Address added', at: now });
  return created;
}

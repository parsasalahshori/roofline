import { eq, sql } from 'drizzle-orm';
import { isTimeZone } from '@roofline/shared';
import { companies } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

const METERS_PER_MILE = 1609.344;

/**
 * Writes the company's address, phone, time zone and map point in one statement. The point and the
 * service area are only written when a point is given; the area is drawn only when a radius is too.
 */
export async function setCompanyLocation(
  tx: Tx,
  ctx: TenantContext,
  i: {
    street: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    phoneE164?: string;
    timezone: string | null;
    point: { lng: number; lat: number } | null;
    serviceAreaMiles: number | null;
  },
): Promise<void> {
  const set: Record<string, unknown> = {
    addressStreet: i.street,
    addressCity: i.city,
    addressState: i.state,
    addressZip: i.zip,
    serviceAreaMiles: i.serviceAreaMiles,
    updatedAt: sql`now()`,
  };
  if (i.phoneE164 !== undefined) set.phoneE164 = i.phoneE164;
  if (i.timezone !== null && isTimeZone(i.timezone)) set.timezone = i.timezone;
  if (i.point) {
    const { lng, lat } = i.point;
    set.location = sql`ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326)`;
    if (i.serviceAreaMiles !== null) {
      const miles = i.serviceAreaMiles;
      set.serviceArea = sql`ST_Multi(ST_Buffer(ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326)::geography, ${miles}::float8 * ${METERS_PER_MILE}::float8)::geometry)`;
    }
  }
  await tx
    .update(companies)
    .set(set as Partial<typeof companies.$inferInsert>)
    .where(eq(companies.id, ctx.companyId));
}

/**
 * Redraws the service area from the stored point with a new radius. False, with no write, when the
 * company has no location yet.
 */
export async function setServiceAreaRadius(tx: Tx, ctx: TenantContext, miles: number): Promise<boolean> {
  const result = await tx.execute(
    sql`update companies set service_area_miles = ${miles}::int, service_area = ST_Multi(ST_Buffer(location::geography, ${miles}::int * ${METERS_PER_MILE}::float8)::geometry), updated_at = now() where id = ${ctx.companyId} and location is not null returning id`,
  );
  return result.rows.length > 0;
}

/**
 * What the sign-up and locate flows need to know: the typed address as one line (null when there is
 * no street, so nothing can be geocoded), whether a point is saved, and the service-area radius.
 */
export async function companyLocationFacts(
  tx: Tx,
  ctx: TenantContext,
): Promise<{ addressText: string | null; located: boolean; serviceAreaMiles: number | null }> {
  const result = await tx.execute(
    sql`select address_street, address_city, address_state, address_zip, (location is not null) as located, service_area_miles from companies where id = ${ctx.companyId}`,
  );
  const row = result.rows[0] as
    | {
        address_street: string | null;
        address_city: string | null;
        address_state: string | null;
        address_zip: string | null;
        located: boolean;
        service_area_miles: number | null;
      }
    | undefined;
  if (!row) return { addressText: null, located: false, serviceAreaMiles: null };

  const street = (row.address_street ?? '').trim();
  const city = (row.address_city ?? '').trim();
  const stateZip = [row.address_state, row.address_zip]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' ');
  const addressText =
    street === ''
      ? null
      : [street, city, stateZip].filter((part) => part !== '').join(', ');

  return {
    addressText,
    located: Boolean(row.located),
    serviceAreaMiles: row.service_area_miles === null ? null : Number(row.service_area_miles),
  };
}

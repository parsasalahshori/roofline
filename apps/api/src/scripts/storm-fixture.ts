import type { Pools } from '@roofline/db';
import { insertFixtureFootprint, insertOmahaStorm, type Query } from '@roofline/db/testing';

/*
 * The Storm Scout end-to-end fixture (S1 Task 28): yesterday's Omaha hail storm over the showcase
 * book, a company_storms row for one company, the properties it hit, a few customers who can be
 * texted and emailed, building footprints for the door routes, and two active (fake) ad accounts.
 *
 * It does NOT draft the plan: the showcase demo task stays the only plan at startup, and the storm
 * spec drafts it through POST /api/storms/:id/plan. The global `storms` table and `building_footprints`
 * cannot be written by the app roles, so the caller passes a `query` that runs as the database owner.
 */

/** How many hit customers get a phone, an email and text consent. */
const CONSENTED_CUSTOMERS = 12;
/** How many building footprints are placed over hit properties (door routes need them). */
const FOOTPRINTS = 24;

/** `YYYY-MM-DD` of the day before `now`, in UTC. */
function dayBefore(now: Date): string {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The hour (0-23) it is at `now` in an IANA zone. */
export function localHour(now: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now));
}

export const DAYTIME_ZONES = [
  'America/Chicago',
  'America/Los_Angeles',
  'America/New_York',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Tokyo',
  'Australia/Sydney',
];

/** The local hours (inclusive) the fixture treats as safely outside quiet hours. */
const DAY_FROM = 9;
const DAY_TO = 19;

/**
 * A company zone where `now` is mid-day, so the send gate (quiet hours) lets the texts and emails go
 * whatever time CI runs. Keeps the default Chicago whenever it is already mid-day there.
 */
export function daytimeZone(now: Date): string {
  return DAYTIME_ZONES.find((zone) => {
    const hour = localHour(now, zone);
    return hour >= DAY_FROM && hour <= DAY_TO;
  }) ?? 'America/Chicago';
}

export async function seedStormFixture(
  pools: Pools,
  companyId: string,
  opts: { now?: Date; query?: Query; footprints?: boolean } = {},
): Promise<{ stormId: string; companyStormId: string }> {
  void pools;
  const q = opts.query;
  if (q === undefined) throw new Error('seedStormFixture needs opts.query, a query that runs as the database owner.');
  const now = opts.now ?? new Date();

  const stormId = await insertOmahaStorm(q, dayBefore(now), 'final');
  await q(`update storms set place_name = 'Omaha, NE' where id = $1`, [stormId]);

  // A plan's email needs the company's mailing address; texting needs an approved registration.
  await q(
    `update companies set address_street = '1200 Farnam St', address_city = 'Omaha', address_state = 'NE', address_zip = '68102' where id = $1`,
    [companyId],
  );
  await q(`update companies set timezone = $2 where id = $1`, [companyId, daytimeZone(now)]);
  await q(
    `insert into texting_registrations (company_id, campaign_status, approved_at) values ($1, 'approved', $2)
     on conflict (company_id) do update set campaign_status = 'approved'`,
    [companyId, now],
  );

  const rows = await q(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit)
     values ($1, $2, 1.5, 0, 0) returning id`,
    [companyId, stormId],
  );
  const companyStormId = rows[0]!.id as string;

  // The properties inside the 0.75 inch contour, each with the biggest hail over it.
  await q(
    `insert into storm_hits (company_id, company_storm_id, property_id, customer_id, hail_in)
     select p.company_id, $2, p.id, p.customer_id,
            coalesce((select max(c.threshold_in) from storm_contours c where c.storm_id = $3 and ST_Intersects(c.geom, p.geom)), 0.75)
       from properties p
      where p.company_id = $1 and p.archived_at is null and p.geom is not null
        and ST_Intersects((select geom_075 from storms where id = $3), p.geom)`,
    [companyId, companyStormId, stormId],
  );
  await q(
    `update company_storms set
       homes_hit = (select count(*) from storm_hits where company_storm_id = $1),
       customers_hit = (select count(distinct customer_id) from storm_hits where company_storm_id = $1)
     where id = $1`,
    [companyStormId],
  );

  // The first hit customers can be texted and emailed.
  await q(
    `with picked as (
       select customer_id, row_number() over (order by customer_id) as n
         from (select distinct customer_id from storm_hits where company_storm_id = $1 and customer_id is not null) d
        order by customer_id limit $2
     )
     update customers c set
       sms_consent_status = 'attested',
       phones = jsonb_build_array(jsonb_build_object('e164', '+140255510' || lpad(picked.n::text, 2, '0'), 'label', 'mobile', 'primary', true)),
       emails = jsonb_build_array('hit' || picked.n || '@example.test')
      from picked where c.id = picked.customer_id`,
    [companyStormId, CONSENTED_CUSTOMERS],
  );

  // Footprints over hit properties inside the 1.0 inch contour, so build_routes has doors. The demo world already has
  // real building outlines under every home and passes `footprints: false`.
  const spots = opts.footprints === false ? [] : await q(
    `select ST_X(p.geom) as lng, ST_Y(p.geom) as lat
       from storm_hits h join properties p on p.id = h.property_id
      where h.company_storm_id = $1 and h.hail_in >= 1.0
      order by p.id limit $2`,
    [companyStormId, FOOTPRINTS],
  );
  for (const s of spots) await insertFixtureFootprint(q, [Number(s.lng), Number(s.lat)]);

  // Each company gets its own external ids: an external ad account belongs to one company (Ruling BF). USD, because
  // the campaign step runs only on a US dollar account.
  const digits = (BigInt(`0x${companyId.replace(/-/g, '').slice(0, 12)}`) % 10_000_000_000n).toString().padStart(10, '0');
  for (const [platform, external] of [
    ['google', digits],
    ['meta', `act_${digits}`],
  ] as const) {
    await q(
      `insert into ad_accounts (company_id, platform, external_account_id, status, name, currency) values ($1, $2, $3, 'active', $4, 'USD')`,
      [companyId, platform, external, `Fixture ${platform} ads`],
    );
  }

  return { stormId, companyStormId };
}

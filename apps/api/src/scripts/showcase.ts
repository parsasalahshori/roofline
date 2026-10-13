import { sql } from 'drizzle-orm';
import {
  createCustomer,
  createJob,
  createProperty,
  getCompanyName,
  type GeoJsonMultiPolygon,
  type LngLat,
  type Pools,
  type PropertyRow,
  setServiceArea,
  type Tx,
  withTenant,
} from '@roofline/db';
import type { JobStage } from '@roofline/shared';
import { systemContext } from '../permissions.ts';
import { demoTask } from '../tasks/demo.ts';
import { createTask } from '../tasks/service.ts';

/*
 * The showcase company: a believable roofing book for demos and the dev seed (Task 9). Sixty
 * customers in Omaha, seventy addresses, twenty-eight jobs across every stage, a service area, and
 * the storm plan waiting for a yes. Everything is fake, and the same every run, so a demo looks the
 * same each time it is made.
 *
 * `buildShowcaseData` is pure: the same data on every call, from one seeded generator (mulberry32,
 * seed 42), with no database and no clock. `seedShowcase` writes that data into one company through
 * the same services the app uses (createCustomer, createProperty, createJob, createTask), as the
 * system (no signed-in person behind it).
 */

/** Omaha, in GeoJSON order (longitude, latitude). Every showcase address sits strictly inside it. */
export const SHOWCASE_SERVICE_AREA: GeoJsonMultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [-96.2, 41.17],
        [-95.9, 41.17],
        [-95.9, 41.37],
        [-96.2, 41.37],
        [-96.2, 41.17],
      ],
    ],
  ],
};

/** The seeded generator (Mulberry32): the same seed always gives the same sequence of numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES: readonly string[] = [
  'Maria', 'James', 'Linda', 'Robert', 'Patricia', 'Michael', 'Barbara', 'William', 'Susan', 'David', 'Karen', 'Richard',
  'Nancy', 'Joseph', 'Lisa', 'Thomas', 'Betty', 'Daniel', 'Sandra', 'Mark', 'Ashley', 'Paul', 'Donna', 'Kevin',
];

const LAST_NAMES: readonly string[] = [
  'Lopez', 'Nguyen', 'Johnson', 'Miller', 'Davis', 'Garcia', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson',
  'Martin', 'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Clark', 'Lewis', 'Walker', 'Hall', 'Young', 'Allen',
];

/** No punctuation: the database normalises addresses, so a street written two ways would be two addresses. */
const STREETS: readonly string[] = [
  'Farnam St', 'Dodge St', 'Pacific St', 'Center St', 'Leavenworth St', 'Harney St', 'Howard St', 'Maple St', 'Cass St',
  'Burt St', 'Underwood Ave', 'Military Ave', 'Blondo St', 'Ames Ave', 'Fort St', 'Saddle Creek Rd', 'Pine St', 'Elm St',
];

const ZIPS: readonly string[] = [
  '68102', '68104', '68105', '68106', '68107', '68108', '68110', '68111', '68112', '68114', '68116', '68118', '68124',
  '68130', '68132', '68134', '68135', '68144', '68154', '68164',
];

/** How many jobs of each stage. The stages are shuffled before they are handed to customers. */
const STAGE_COUNTS: readonly (readonly [JobStage, number])[] = [
  ['lead', 8],
  ['inspection', 7],
  ['proposal', 6],
  ['won', 4],
  ['installed', 2],
  ['lost', 1],
];

const CUSTOMER_COUNT = 60;
/** Every sixth customer (0, 6, ..., 54) has a second address. */
const SECOND_ADDRESS_EVERY = 6;
/** The first customers, in order, get the jobs. */
const JOB_COUNT = STAGE_COUNTS.reduce((sum, [, count]) => sum + count, 0);

const LOST_REASON = 'Went with another roofer';

export type ShowcaseProperty = {
  addressLine: string;
  city: string;
  state: string;
  zip: string;
  /** `[longitude, latitude]`, at most five decimals. */
  location: LngLat;
};

export type ShowcaseJob = {
  stage: JobStage;
  /** Null for a lead and an inspection; otherwise a whole number of thousands of dollars, in cents. */
  valueCents: number | null;
  lostReason: string | null;
};

export type ShowcaseCustomer = {
  firstName: string;
  lastName: string;
  displayName: string;
  properties: ShowcaseProperty[];
  /** The job on the customer's first address, or null. */
  job: ShowcaseJob | null;
};

export type ShowcaseData = { customers: ShowcaseCustomer[] };

const round5 = (x: number): number => Math.round(x * 1e5) / 1e5;

/** The showcase's customers, addresses and jobs. Pure: the same value on every call. */
export function buildShowcaseData(): ShowcaseData {
  const rand = mulberry32(42);
  const pick = (list: readonly string[]): string => list[Math.floor(rand() * list.length)]!;

  // The 28 stages, shuffled (Fisher-Yates).
  const stages: JobStage[] = [];
  for (const [stage, count] of STAGE_COUNTS) for (let n = 0; n < count; n += 1) stages.push(stage);
  for (let i = stages.length - 1; i >= 1; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const held = stages[i]!;
    stages[i] = stages[j]!;
    stages[j] = held;
  }

  const usedNames = new Set<string>();
  const usedAddresses = new Set<string>();
  const customers: ShowcaseCustomer[] = [];

  for (let i = 0; i < CUSTOMER_COUNT; i += 1) {
    let firstName: string;
    let lastName: string;
    let displayName: string;
    do {
      firstName = pick(FIRST_NAMES);
      lastName = pick(LAST_NAMES);
      displayName = `${firstName} ${lastName}`;
    } while (usedNames.has(displayName));
    usedNames.add(displayName);

    const propertyCount = i % SECOND_ADDRESS_EVERY === 0 ? 2 : 1;
    const properties: ShowcaseProperty[] = [];
    for (let p = 0; p < propertyCount; p += 1) {
      let addressLine: string;
      let zip: string;
      let addressKey: string;
      do {
        addressLine = `${100 + Math.floor(rand() * 9800)} ${pick(STREETS)}`;
        zip = pick(ZIPS);
        addressKey = `${addressLine.toLowerCase()}|${zip}`;
      } while (usedAddresses.has(addressKey));
      usedAddresses.add(addressKey);

      const lng = round5(-96.19 + rand() * 0.28);
      const lat = round5(41.18 + rand() * 0.18);
      properties.push({ addressLine, city: 'Omaha', state: 'NE', zip, location: [lng, lat] });
    }

    let job: ShowcaseJob | null = null;
    if (i < JOB_COUNT) {
      const stage = stages[i]!;
      job = {
        stage,
        valueCents: stage === 'lead' || stage === 'inspection' ? null : (8 + Math.floor(rand() * 15)) * 100_000,
        lostReason: stage === 'lost' ? LOST_REASON : null,
      };
    }

    customers.push({ firstName, lastName, displayName, properties, job });
  }

  return { customers };
}

/** The company's first active rep (by email, then id), or null when it has none. `company_members` is the only way the tenant role sees members. */
async function firstRepId(tx: Tx): Promise<string | null> {
  const result = await tx.execute(
    sql`select user_id from company_members where role = 'rep' and status = 'active' order by email::text, user_id limit 1`,
  );
  const row = result.rows[0];
  return row ? (row.user_id as string) : null;
}

/**
 * Writes the showcase into one company, in one tenant transaction, as the system (no signed-in
 * person): its service area, 60 customers and 70 addresses, 28 jobs, and the storm plan (a draft
 * waiting for a yes). Leads have nobody assigned; every other job goes to the company's first rep,
 * or stays unassigned when it has none. `companyName` defaults to the company's own name.
 *
 * Returns the counts it actually created and the new plan's id.
 *
 * Not idempotent: a second run in the same company collides on the addresses. The dev seed calls it
 * only for a company it has just made. Two runs on fresh databases give identical names and
 * coordinates. `relocate` moves each address's point (the demo world puts them on real buildings).
 */
export async function seedShowcase(
  pools: Pools,
  companyId: string,
  now: Date,
  opts: { companyName?: string; relocate?: (location: LngLat) => LngLat } = {},
): Promise<{ customers: number; properties: number; jobs: number; taskId: string }> {
  const ctx = systemContext(companyId);
  const data = buildShowcaseData();

  return withTenant(pools, ctx, async (tx) => {
    const companyName = opts.companyName ?? (await getCompanyName(tx, ctx));
    if (companyName === null) throw new Error(`The company ${companyId} cannot be read, so the showcase cannot name it.`);

    await setServiceArea(tx, SHOWCASE_SERVICE_AREA);
    const repId = await firstRepId(tx);

    let customerCount = 0;
    let propertyCount = 0;
    let jobCount = 0;
    for (const item of data.customers) {
      const customer = await createCustomer(
        tx,
        ctx,
        { displayName: item.displayName, firstName: item.firstName, lastName: item.lastName },
        { now },
      );
      customerCount += 1;

      const addresses: PropertyRow[] = [];
      for (const place of item.properties) {
        addresses.push(
          await createProperty(
            tx,
            ctx,
            {
              customerId: customer.id,
              addressLine: place.addressLine,
              city: place.city,
              state: place.state,
              zip: place.zip,
              location: opts.relocate === undefined ? place.location : opts.relocate(place.location),
            },
            { now },
          ),
        );
      }
      propertyCount += addresses.length;

      if (item.job !== null) {
        const first = addresses[0];
        if (first === undefined) throw new Error(`The showcase customer ${item.displayName} has a job but no address.`);
        await createJob(
          tx,
          ctx,
          {
            customerId: customer.id,
            propertyId: first.id,
            stage: item.job.stage,
            source: 'manual',
            valueCents: item.job.valueCents,
            assignedUserId: item.job.stage === 'lead' ? null : repId,
            lostReason: item.job.lostReason,
          },
          { now },
        );
        jobCount += 1;
      }
    }

    const { taskId } = await createTask(tx, ctx, demoTask(now, companyName), { now, ip: null });
    return { customers: customerCount, properties: propertyCount, jobs: jobCount, taskId };
  });
}

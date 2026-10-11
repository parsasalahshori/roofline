import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, inject, it } from 'vitest';
import { agentTaskSteps, companies, customers, jobs, properties } from '@roofline/db';
import { resetDb, seedCompany, seedTwoCompanies } from '@roofline/db/testing';
import { buildShowcaseData, SHOWCASE_SERVICE_AREA, seedShowcase, type ShowcaseCustomer } from '../src/scripts/showcase.ts';
import { Actors, inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many of each stage the showcase makes, lead first. */
const EXPECTED_STAGES = { lead: 8, inspection: 7, proposal: 6, won: 4, installed: 2, lost: 1 };

/** The open stages, as the map shows them. */
const OPEN_STAGES = { lead: 8, inspection: 7, proposal: 6, won: 4 };

/** Counts rows by their `stage` column. */
function countStages<T extends { stage: string }>(rows: readonly T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.stage] = (counts[row.stage] ?? 0) + 1;
  return counts;
}

/** The number of decimal places a number prints with. */
function decimalsOf(value: number): number {
  const text = String(value);
  return text.includes('.') ? text.split('.')[1]!.length : 0;
}

describe('the showcase data (pure)', () => {
  const data = buildShowcaseData();
  const all = data.customers;
  const allProperties = all.flatMap((c) => c.properties);
  const withJob = all.filter((c): c is ShowcaseCustomer & { job: NonNullable<ShowcaseCustomer['job']> } => c.job !== null);

  it('makes 60 customers, 70 addresses and 28 jobs', () => {
    expect(all).toHaveLength(60);
    expect(allProperties).toHaveLength(70);
    expect(withJob).toHaveLength(28);
  });

  it('has exactly the stage counts the demo needs', () => {
    expect(countStages(withJob.map((c) => c.job))).toEqual(EXPECTED_STAGES);
  });

  it('gives every customer a unique display name', () => {
    expect(new Set(all.map((c) => c.displayName)).size).toBe(60);
  });

  it('gives every address a unique key (street and ZIP, ignoring case)', () => {
    const keys = allProperties.map((p) => `${p.addressLine.toLowerCase()}|${p.zip}`);
    expect(new Set(keys).size).toBe(70);
  });

  it('puts every address strictly inside the service area, at no more than 5 decimals', () => {
    for (const place of allProperties) {
      const [lng, lat] = place.location;
      expect(lng, place.addressLine).toBeGreaterThan(-96.2);
      expect(lng, place.addressLine).toBeLessThan(-95.9);
      expect(lat, place.addressLine).toBeGreaterThan(41.17);
      expect(lat, place.addressLine).toBeLessThan(41.37);
      expect(decimalsOf(lng), place.addressLine).toBeLessThanOrEqual(5);
      expect(decimalsOf(lat), place.addressLine).toBeLessThanOrEqual(5);
    }
  });

  it('puts the jobs on the first address of the first 28 customers, so the 28 jobs sit on 28 distinct addresses', () => {
    expect(all.slice(0, 28).every((c) => c.job !== null)).toBe(true);
    expect(all.slice(28).every((c) => c.job === null)).toBe(true);
    const firstAddresses = withJob.map((c) => `${c.properties[0]!.addressLine.toLowerCase()}|${c.properties[0]!.zip}`);
    expect(new Set(firstAddresses).size).toBe(28);
  });

  it('makes the same data on every call', () => {
    expect(JSON.stringify(buildShowcaseData())).toBe(JSON.stringify(data));
  });

  it('describes the service area as one Omaha polygon in longitude, latitude order', () => {
    expect(SHOWCASE_SERVICE_AREA.type).toBe('MultiPolygon');
    expect(SHOWCASE_SERVICE_AREA.coordinates).toEqual([
      [
        [
          [-96.2, 41.17],
          [-95.9, 41.17],
          [-95.9, 41.37],
          [-96.2, 41.37],
          [-96.2, 41.17],
        ],
      ],
    ]);
  });
});

describe('seedShowcase', () => {
  let t: TestApp;
  let who: Actors;

  beforeEach(async () => {
    t = await makeTestApp();
    who = new Actors(t);
  });

  it('seeds a believable company', async () => {
    const companyId = t.seed.a.companyId;
    const out = await seedShowcase(t.deps.pools, companyId, t.clock.now(), { companyName: 'Acme Roofing' });
    expect(out).toMatchObject({ customers: 60, properties: 70, jobs: 28 });
    expect(out.taskId).toMatch(UUID);

    const owner = await who.as('owner');

    const area = await owner.get('/api/map/area');
    expect(area.status).toBe(200);
    expect(area.body.serviceArea.type).toBe('MultiPolygon');
    expect(area.body.serviceArea.coordinates).toEqual(SHOWCASE_SERVICE_AREA.coordinates);
    expect(area.body.bounds).toEqual([-96.2, 41.17, -95.9, 41.37]);

    const pins = await owner.get('/api/map/pins').query({ bbox: area.body.bounds.join(',') });
    expect(pins.status).toBe(200);
    expect(pins.body.mode).toBe('points');
    expect(pins.body.customers).toHaveLength(70);
    expect(pins.body.jobs).toHaveLength(25);
    expect(countStages(pins.body.jobs)).toEqual(OPEN_STAGES);

    const approvals = await owner.get('/api/approvals');
    expect(approvals.status).toBe(200);
    expect(approvals.body.count).toBe(1);
    expect(approvals.body.tasks[0].steps[0].type).toBe('demo_message');
    expect(approvals.body.tasks[0].steps[0].preview.recipientCount).toBe(31);
    expect(approvals.body.tasks[0].steps[0].preview.messageSample).toContain("it's Acme Roofing.");

    const rows = await inCompany(t, companyId, (tx) => tx.select({ stage: jobs.stage, propertyId: jobs.propertyId }).from(jobs));
    expect(rows).toHaveLength(28);
    expect(countStages(rows)).toEqual(EXPECTED_STAGES);
    expect(new Set(rows.map((r) => r.propertyId)).size).toBe(28);
  });

  it('is the same every run', async () => {
    const urls = inject('dbUrls');

    // Everything the showcase writes, as the names and coordinates a person would see: sorted, so row order does not matter.
    const snapshot = (companyId: string) =>
      inCompany(t, companyId, async (tx) => {
        const names = (await tx.select({ displayName: customers.displayName }).from(customers)).map((r) => r.displayName).sort();
        const places = (
          await tx
            .select({
              addressLine: properties.addressLine,
              x: sql<number>`ST_X(${properties.geom})`,
              y: sql<number>`ST_Y(${properties.geom})`,
            })
            .from(properties)
        )
          .map((r) => [r.addressLine, r.x, r.y])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        return { names, places };
      });

    await seedShowcase(t.deps.pools, t.seed.a.companyId, t.clock.now());
    const run1 = await snapshot(t.seed.a.companyId);
    expect(run1.names).toHaveLength(60);
    expect(run1.places).toHaveLength(70);

    await resetDb(urls.owner);
    const seed2 = await seedTwoCompanies(urls.owner);
    await seedShowcase(t.deps.pools, seed2.a.companyId, t.clock.now());
    const run2 = await snapshot(seed2.a.companyId);

    expect(run2).toEqual(run1);
  });

  it('puts the leads with nobody and everything else with the first rep', async () => {
    await seedShowcase(t.deps.pools, t.seed.a.companyId, t.clock.now());
    const rows = await inCompany(t, t.seed.a.companyId, (tx) => tx.select({ stage: jobs.stage, assignedUserId: jobs.assignedUserId }).from(jobs));

    const leads = rows.filter((r) => r.stage === 'lead');
    expect(leads).toHaveLength(8);
    expect(leads.every((r) => r.assignedUserId === null)).toBe(true);

    const others = rows.filter((r) => r.stage !== 'lead');
    expect(others).toHaveLength(20);
    expect(others.every((r) => r.assignedUserId !== null)).toBe(true);
    const assignees = new Set(others.map((r) => r.assignedUserId));
    expect(assignees.size).toBe(1);
    expect([t.seed.a.rep.userId, t.seed.a.otherRep.userId]).toContain([...assignees][0]);
  });

  it('works for a company with no rep and finds the company name itself', async () => {
    const urls = inject('dbUrls');
    const solo = await seedCompany(urls.owner, {
      name: 'Solo Roofing',
      slug: 'solo-roofing',
      password: 'showcase-test-pw',
      users: [{ email: 'solo@solo.test', name: 'Solo Owner', role: 'owner' }],
    });

    const out = await seedShowcase(t.deps.pools, solo.companyId, t.clock.now());
    expect(out).toMatchObject({ customers: 60, properties: 70, jobs: 28 });

    const rows = await inCompany(t, solo.companyId, (tx) => tx.select({ assignedUserId: jobs.assignedUserId }).from(jobs));
    expect(rows).toHaveLength(28);
    expect(rows.every((r) => r.assignedUserId === null)).toBe(true);

    const steps = await inCompany(t, solo.companyId, (tx) =>
      tx
        .select({ type: agentTaskSteps.type, payload: agentTaskSteps.payload })
        .from(agentTaskSteps)
        .where(eq(agentTaskSteps.taskId, out.taskId)),
    );
    const message = steps.find((s) => s.type === 'demo_message');
    expect(message?.payload).toMatchObject({ sample: expect.stringContaining("it's Solo Roofing.") });

    const [company] = await inCompany(t, solo.companyId, (tx) =>
      tx.select({ hasArea: sql<boolean>`${companies.serviceArea} is not null` }).from(companies).where(eq(companies.id, solo.companyId)),
    );
    expect(company?.hasArea).toBe(true);
  });
});

import request from 'supertest';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';
import { decrypt } from '@roofline/db';
import { JOB_STAGES } from '@roofline/shared';
import { DEMO_BUILDINGS } from '../src/demo/places.ts';
import { DEMO_LOOKUP_LOTS } from '../src/providers/fakes/geocoder.ts';
import { MemoryObjectStore } from '../src/providers/fakes/object-store.ts';
import { DEMO_COMPANY_NAME, DEMO_COMPANY_SLUG, DEMO_LOGIN, seedDemoWorld } from '../src/scripts/demo-world.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from './helpers.ts';

let t: TestApp;
let owner: pg.Client;

beforeEach(async () => {
  t = await makeTestApp();
  owner = new pg.Client({ connectionString: inject('dbUrls').owner });
  await owner.connect();
});

afterEach(async () => {
  await owner.end();
});

describe('the demo world', () => {
  test('makes Summit Ridge Roofing with every part of the walkthrough, and a second run changes nothing', async () => {
    const ownerUrl = inject('dbUrls').owner;
    const now = t.clock.now();
    const store = new MemoryObjectStore();
    const first = await seedDemoWorld(t.deps.pools, ownerUrl, now, { encryptionKey: TEST_ENCRYPTION_KEY, objectStore: store });
    expect(first.created).toBe(true);

    // The signed proposal's PDF is made by the seed, so the homeowner page offers it straight away.
    const signedPdf = (
      await owner.query(
        `select f.object_key from proposal_signatures s join stored_files f on f.id = s.pdf_file_id where s.company_id = $1`,
        [first.companyId],
      )
    ).rows;
    expect(signedPdf).toHaveLength(1);
    const pdf = await store.get(String(signedPdf[0]?.object_key));
    expect(Buffer.from(pdf ?? []).subarray(0, 5).toString()).toBe('%PDF-');

    const company = (await owner.query(`select name, slug, timezone from companies where id = $1`, [first.companyId])).rows[0];
    expect(company).toMatchObject({ name: DEMO_COMPANY_NAME, slug: DEMO_COMPANY_SLUG });

    const c = first.counts;
    expect(c.members).toBe(4);
    expect(c.customers).toBeGreaterThanOrEqual(60);
    for (const stage of JOB_STAGES) expect(c[`jobs.${stage}`] ?? 0, stage).toBeGreaterThan(0);
    expect(c['proposals.signed']).toBe(1);
    expect((c['proposals.sent'] ?? 0) + (c['proposals.viewed'] ?? 0)).toBe(2);
    expect(c['proposals.draft']).toBe(1);
    expect(c.measurements).toBe(4);
    expect(c.stormHits).toBeGreaterThan(0);
    expect(c.calls).toBe(2);
    expect(c.conversations).toBe(5);
    expect(c.claims).toBe(1);
    expect(c.appointments).toBeGreaterThanOrEqual(8);
    expect(c.minutesSaved).toBeGreaterThan(0);
    expect(c['agentTasks.draft']).toBeGreaterThanOrEqual(3);

    // The storm plan is drafted for the company storm, and the hit properties are the demo company's own.
    const storm = (await owner.query(`select plan_task_id from company_storms where company_id = $1`, [first.companyId])).rows[0];
    expect(storm?.plan_task_id).toBeTruthy();
    const foreign = await owner.query(
      `select count(*)::int as n from storm_hits h join properties p on p.id = h.property_id where h.company_id = $1 and p.company_id <> $1`,
      [first.companyId],
    );
    expect(foreign.rows[0].n).toBe(0);

    // The owner signs in with the demo credential.
    const login = await request(t.app).post('/api/auth/login').send({ email: DEMO_LOGIN.email, password: DEMO_LOGIN.password });
    expect(login.status).toBe(200);

    // A sent proposal's minted link opens the homeowner page.
    const sent = await owner.query(
      `select link_token_encrypted from proposals where company_id = $1 and status in ('sent', 'viewed') order by number limit 1`,
      [first.companyId],
    );
    const token = decrypt(sent.rows[0].link_token_encrypted as Buffer, TEST_ENCRYPTION_KEY);
    const page = await request(t.app).get(`/api/public/proposals/${token}`);
    expect(page.status).toBe(200);
    expect(page.body.status).toBe('open');

    // "Estimate this roof": every home sits inside a building outline, and there are empty neighbouring houses too.
    const outlines = (
      await owner.query(
        `select count(*)::int as homes,
                count(*) filter (where exists (select 1 from building_footprints b where ST_Contains(b.geom, p.geom)))::int as covered
           from properties p where p.company_id = $1 and p.geom is not null`,
        [first.companyId],
      )
    ).rows[0] as { homes: number; covered: number };
    expect(outlines.homes).toBeGreaterThan(50);
    expect(outlines.covered).toBe(outlines.homes);
    const empty = (
      await owner.query(
        `select count(*)::int as n from building_footprints b
          where b.source_ref like 'demo-next-%'
            and not exists (select 1 from properties p where p.company_id = $1 and ST_Contains(b.geom, p.geom))`,
        [first.companyId],
      )
    ).rows[0] as { n: number };
    expect(empty.n).toBeGreaterThan(50);
    // The counts the demo promises.
    expect(c.customers).toBe(66);
    expect(c.properties).toBe(76);
    expect(c.stormHits).toBe(37);
    expect(c.measurements).toBe(4);
    const total = (prefix: string) => Object.entries(c).filter(([k]) => k.startsWith(prefix)).reduce((n, [, v]) => n + v, 0);
    expect(total('jobs.')).toBe(30);
    expect(total('proposals.')).toBe(4);
    // Real outlines (Microsoft's, with L-shapes and other corners), not drawn rectangles, and the seeded measurements were
    // traced on them.
    const shapes = (
      await owner.query(
        `select count(*)::int as total, count(*) filter (where ST_NPoints(geom) > 5)::int as shaped
           from building_footprints where state = 'NE' and source = 'microsoft'`,
      )
    ).rows[0] as { total: number; shaped: number };
    expect(shapes.total).toBe(DEMO_BUILDINGS.length);
    expect(shapes.shaped).toBeGreaterThan(shapes.total / 2);
    const traced = (
      await owner.query(
        `select count(*)::int as n from measurements m join properties p on p.id = m.property_id
          where m.company_id = $1 and p.footprint_id is not null and ST_NPoints(m.outline) > 5`,
        [first.companyId],
      )
    ).rows[0] as { n: number };
    expect(traced.n).toBe(4);
    // Every lot the demo geocoder sends a typed address to has its roof (else that address would open draw mode).
    for (const [lng, lat] of DEMO_LOOKUP_LOTS) {
      const lot = (
        await owner.query(
          `select count(*)::int as n from building_footprints b where b.state = 'NE' and ST_Covers(b.geom, ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326))`,
          [lng, lat],
        )
      ).rows[0] as { n: number };
      expect(lot.n, `lot ${lng},${lat}`).toBeGreaterThan(0);
    }

    // The finished storm plan's approval carries the counts a real approval writes, so the feed does not say it was
    // "approved with every step switched off" when it sent 48 texts.
    const approval = (
      await owner.query(
        `select e.data from agent_task_events e join agent_tasks t on t.id = e.task_id
          where e.company_id = $1 and e.kind = 'approved' and t.title = 'Storm plan for Elkhorn'`,
        [first.companyId],
      )
    ).rows;
    expect(approval).toHaveLength(1);
    expect(approval[0]?.data).toEqual({ totalSteps: 1, approvedSteps: 1, forwardedSteps: 0 });

    const second = await seedDemoWorld(t.deps.pools, ownerUrl, now, { encryptionKey: TEST_ENCRYPTION_KEY });
    expect(second).toEqual({ created: false, companyId: first.companyId, counts: first.counts });
  });
});

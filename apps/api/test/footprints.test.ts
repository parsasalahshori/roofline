import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { beforeEach, describe, expect, inject, test } from 'vitest';
import { withTenant } from '@roofline/db';
import {
  claimFootprintState,
  failFootprintState,
  finishFootprintState,
  footprintStateStatus,
  insertFootprints,
  STALE_LOADING_MS,
  statesNeedingFootprints,
  statesNeedingFootprintsFor,
  type FootprintInput,
} from '@roofline/db/system';
import { SEED_PASSWORD, seedCompany } from '@roofline/db/testing';
import type { AppDeps } from '../src/app.ts';
import { FOOTPRINT_BATCH_SIZE, FOOTPRINT_LOAD_FAILED_PLAIN, loadFootprintState } from '../src/estimator/footprints-load.ts';
import { InlineJobs } from '../src/jobs/queue.ts';
import { ensureFootprints } from '../src/jobs/scheduler/footprints-ensure.ts';
import { FakeFootprintSource } from '../src/providers/fakes/footprints.ts';
import type { FootprintFeature, FootprintSource } from '../src/providers/footprints.ts';
import { MicrosoftFootprints } from '../src/providers/ms-footprints.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * The footprint loader and its lookups. The footprint tables are global (no company id), and
 * makeTestApp empties the whole database before every test, so nothing leaks between tests.
 * Raw counts are read through the owner connection, which sees every table.
 */

const NOW = new Date('2026-10-12T15:00:00.000Z');
const FIRST_ATTEMPT = { attempt: 1, lastAttempt: false } as const;
const LAST_ATTEMPT = { attempt: 5, lastAttempt: true } as const;
const NE_ZIP = fileURLToPath(new URL('./fixtures/footprints/NE.geojson.zip', import.meta.url));

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  // The seeded companies have no state unless a test gives them one.
  await owner(`update companies set address_state = null`);
});

/** One statement through the owner connection (it sees every table). */
async function owner<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

const countFor = async (state: string) =>
  Number((await owner<{ n: string }>(`select count(*) as n from building_footprints where state = $1`, [state]))[0]!.n);

const stateRow = async (state: string) =>
  (await owner<Record<string, unknown>>(`select * from building_footprint_states where state = $1`, [state]))[0];

const system = () => t.deps.pools.system;

async function collectAll<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** A square about 40 m on a side, its corner at (lng, lat): a plausible building. */
function square(lng: number, lat: number): FootprintFeature['ring'] {
  const d = 0.0004;
  return [
    [lng, lat],
    [lng + d, lat],
    [lng + d, lat + d],
    [lng, lat + d],
    [lng, lat],
  ];
}

/** A source that yields `count` squares (each a little east of the last) for any state. */
function squaresSource(count: number): FootprintSource {
  return {
    configured: true,
    stateFileUrl: (state) => `https://custom.test/${state}.zip`,
    async *features() {
      for (let i = 0; i < count; i++) yield { sourceRef: `sq-${i}`, ring: square(-96 + i * 0.0001, 41) };
    },
  };
}

/** A source that yields three good buildings and then throws text that must never be stored. */
function breakingSource(): FootprintSource {
  return {
    configured: true,
    stateFileUrl: (state) => `https://custom.test/${state}.zip`,
    async *features() {
      for (let i = 0; i < 3; i++) yield { sourceRef: `ok-${i}`, ring: square(-96 + i * 0.001, 41) };
      throw new Error('PROVIDER SECRET TEXT');
    },
  };
}

const depsWith = (footprints: FootprintSource): AppDeps => ({ ...t.deps, footprints });

let companySeq = 0;
/** A company with the given state (null: none), made through the owner connection. */
async function companyIn(state: string | null): Promise<string> {
  companySeq++;
  const made = await seedCompany(inject('dbUrls').owner, {
    name: `Footprint Co ${companySeq}`,
    slug: `footprint-co-${companySeq}-${Date.now()}`,
    ...(state === null ? {} : { state }),
    users: [],
    password: SEED_PASSWORD,
  });
  return made.companyId;
}

describe('loadFootprintState', () => {
  test('the fixture zip loads', async () => {
    const zip = new Uint8Array(readFileSync(NE_ZIP));
    const footprints = new MicrosoftFootprints({ baseUrl: 'https://x.test/', fetch: async () => new Response(zip) });

    await loadFootprintState(depsWith(footprints), 'NE', FIRST_ATTEMPT);

    expect(await footprintStateStatus(system(), 'NE')).toBe('ready');
    const row = await stateRow('NE');
    expect(row).toMatchObject({ status: 'ready', buildings: 6, error_plain: null, source_url: 'https://x.test/Nebraska.geojson.zip' });
    expect(row!.loaded_at).toBeInstanceOf(Date);
    expect(await countFor('NE')).toBe(6);
    const rows = await owner<{ area: string; valid: boolean }>(
      `select area_sq_ft::text as area, ST_IsValid(geom) as valid from building_footprints where state = 'NE'`,
    );
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(Number(r.area)).toBeGreaterThan(100);
      expect(Number(r.area)).toBeLessThan(100000);
      expect(r.valid).toBe(true);
    }
  });

  test('the fake source also loads NE', async () => {
    await loadFootprintState(depsWith(new FakeFootprintSource()), 'NE', FIRST_ATTEMPT);
    expect(await footprintStateStatus(system(), 'NE')).toBe('ready');
    expect(await countFor('NE')).toBe(6);
    expect(await stateRow('NE')).toMatchObject({ buildings: 6 });
  });

  test('a failing stream marks failed and leaves no rows', async () => {
    await expect(loadFootprintState(depsWith(breakingSource()), 'NE', LAST_ATTEMPT)).rejects.toThrow();

    expect(await footprintStateStatus(system(), 'NE')).toBe('failed');
    expect(await countFor('NE')).toBe(0);
    const row = await stateRow('NE');
    expect(row!.error_plain).toBe(FOOTPRINT_LOAD_FAILED_PLAIN);
    expect(String(row!.error_plain)).not.toContain('SECRET');
    expect(JSON.stringify(row)).not.toContain('SECRET');
  });

  test('a retry after a failure loads cleanly', async () => {
    await expect(loadFootprintState(depsWith(breakingSource()), 'NE', FIRST_ATTEMPT)).rejects.toThrow();
    expect(await footprintStateStatus(system(), 'NE')).toBe('failed');

    await loadFootprintState(depsWith(new FakeFootprintSource()), 'NE', { attempt: 2, lastAttempt: false });

    expect(await footprintStateStatus(system(), 'NE')).toBe('ready');
    expect(await countFor('NE')).toBe(6);
    expect(await stateRow('NE')).toMatchObject({ buildings: 6, error_plain: null });
  });

  test('loading over rows left by a crash replaces them', async () => {
    const start = t.clock.now();
    expect(await claimFootprintState(system(), 'NE', 'https://old.test/NE.zip', start)).toBe(true);
    expect(await insertFootprints(system(), 'NE', [{ sourceRef: 'left-over', ring: square(-96, 41) }])).toBe(1);
    expect(await countFor('NE')).toBe(1);

    // The crashed worker's claim is stale: a new job takes it over and replaces the rows.
    t.clock.set(new Date(start.getTime() + STALE_LOADING_MS + 1000));
    await loadFootprintState(depsWith(new FakeFootprintSource()), 'NE', FIRST_ATTEMPT);

    expect(await footprintStateStatus(system(), 'NE')).toBe('ready');
    expect(await countFor('NE')).toBe(6);
    const refs = await owner<{ source_ref: string }>(`select source_ref from building_footprints where state = 'NE'`);
    expect(refs.map((r) => r.source_ref)).not.toContain('left-over');
  });

  test('a load for a state that is already loading does nothing', async () => {
    expect(await claimFootprintState(system(), 'NE', 'https://other.test/NE.zip', t.clock.now())).toBe(true);
    const fake = new FakeFootprintSource();
    await loadFootprintState(depsWith(fake), 'NE', FIRST_ATTEMPT);
    expect(await footprintStateStatus(system(), 'NE')).toBe('loading');
    expect(await countFor('NE')).toBe(0);
  });

  test('batches of 2,000', async () => {
    const count = FOOTPRINT_BATCH_SIZE * 2 + 1;
    expect(count).toBe(4001);
    await loadFootprintState(depsWith(squaresSource(count)), 'IA', FIRST_ATTEMPT);
    expect(await footprintStateStatus(system(), 'IA')).toBe('ready');
    expect(await stateRow('IA')).toMatchObject({ buildings: 4001 });
    expect(await countFor('IA')).toBe(4001);
  });
});

describe('claimFootprintState', () => {
  test('a second claim while loading is refused; a ready state cannot be claimed; a stale claim can', async () => {
    const start = t.clock.now();
    expect(await claimFootprintState(system(), 'NE', 'https://x.test/NE.zip', start)).toBe(true);
    expect(await footprintStateStatus(system(), 'NE')).toBe('loading');
    expect(await claimFootprintState(system(), 'NE', 'https://x.test/NE.zip', start)).toBe(false);

    // Just inside the limit it is still someone's.
    expect(await claimFootprintState(system(), 'NE', 'https://x.test/NE.zip', new Date(start.getTime() + STALE_LOADING_MS - 1000))).toBe(false);

    // Past the limit it is a crashed worker's, and can be taken again.
    expect(await claimFootprintState(system(), 'NE', 'https://x.test/NE.zip', new Date(start.getTime() + STALE_LOADING_MS + 1000))).toBe(true);

    await finishFootprintState(system(), 'NE', 0, start);
    expect(await footprintStateStatus(system(), 'NE')).toBe('ready');
    expect(await claimFootprintState(system(), 'NE', 'https://x.test/NE.zip', new Date(start.getTime() + STALE_LOADING_MS * 10))).toBe(false);
  });

  test('a failed state can be claimed again, and an unknown state has no status', async () => {
    expect(await footprintStateStatus(system(), 'NE')).toBeNull();
    expect(await claimFootprintState(system(), 'NE', 'https://x.test/NE.zip', NOW)).toBe(true);
    await failFootprintState(system(), 'NE', FOOTPRINT_LOAD_FAILED_PLAIN, NOW);
    expect(await footprintStateStatus(system(), 'NE')).toBe('failed');
    expect(await claimFootprintState(system(), 'NE', 'https://x.test/NE.zip', NOW)).toBe(true);
    expect(await footprintStateStatus(system(), 'NE')).toBe('loading');
  });
});

describe('insertFootprints', () => {
  test('keeps only valid polygons and returns the count', async () => {
    await claimFootprintState(system(), 'NE', 'https://x.test/NE.zip', NOW);
    const normal: FootprintInput = { sourceRef: 'normal', ring: square(-96, 41) };
    const threePoints: FootprintInput = {
      sourceRef: 'three',
      ring: [
        [-96, 41],
        [-95.9996, 41],
        [-96, 41],
      ],
    };
    // A bowtie: the ring crosses itself. It is made valid or skipped, never an error.
    const bowtie: FootprintInput = {
      sourceRef: 'bowtie',
      ring: [
        [-96, 41],
        [-95.9996, 41.0004],
        [-95.9996, 41],
        [-96, 41.0004],
        [-96, 41],
      ],
    };

    expect(await insertFootprints(system(), 'NE', [normal])).toBe(1);
    expect(await insertFootprints(system(), 'NE', [threePoints])).toBe(0);
    expect(await insertFootprints(system(), 'NE', [])).toBe(0);
    const bowtieCount = await insertFootprints(system(), 'NE', [bowtie]);
    expect(bowtieCount).toBeGreaterThanOrEqual(0);
    expect(bowtieCount).toBeLessThanOrEqual(1);

    expect(await countFor('NE')).toBe(1 + bowtieCount);
    const invalid = await owner<{ n: string }>(`select count(*) as n from building_footprints where not ST_IsValid(geom)`);
    expect(Number(invalid[0]!.n)).toBe(0);
  });
});

describe('statesNeedingFootprints', () => {
  test('a company in NE needs NE; a ready state is gone; a failed one is listed again', async () => {
    const neCompany = await companyIn('NE');
    await companyIn(null);
    await companyIn('ZZ');

    const needed = await statesNeedingFootprints(system());
    expect(needed).toContain('NE');
    expect(needed).not.toContain('ZZ');
    expect(await statesNeedingFootprintsFor(system())).toEqual([{ state: 'NE', companyId: neCompany }]);

    await loadFootprintState(depsWith(new FakeFootprintSource()), 'NE', FIRST_ATTEMPT);
    expect(await statesNeedingFootprints(system())).not.toContain('NE');

    // A failed state is needed again.
    await owner(`update building_footprint_states set status = 'failed' where state = 'NE'`);
    expect(await statesNeedingFootprints(system())).toContain('NE');
    expect(await statesNeedingFootprintsFor(system())).toEqual([{ state: 'NE', companyId: neCompany }]);
  });

  test('a state that is loading right now is not listed', async () => {
    await companyIn('NE');
    await claimFootprintState(system(), 'NE', 'https://x.test/NE.zip', new Date());
    expect(await statesNeedingFootprints(system())).not.toContain('NE');
  });
});

describe('ensureFootprints', () => {
  test('the schedule queues one job per state (singleton)', async () => {
    const ne1 = await companyIn('NE');
    const ne2 = await companyIn('NE');
    const ia = await companyIn('IA');
    const jobs = new InlineJobs();
    const deps: AppDeps = { ...t.deps, jobs };

    await ensureFootprints(deps, NOW);

    expect(jobs.sent).toHaveLength(2);
    expect(jobs.sent.map((s) => s.name)).toEqual(['footprints-load', 'footprints-load']);
    const byState = [...jobs.sent].sort((a, b) => String(a.data.state).localeCompare(String(b.data.state)));
    expect(byState.map((s) => s.data.state)).toEqual(['IA', 'NE']);
    for (const s of byState) expect(s.singletonKey).toBe(s.data.state);
    expect(byState[0]!.data.companyId).toBe(ia);
    expect([ne1, ne2]).toContain(byState[1]!.data.companyId);

    // Run again with the first two still waiting: both sends are recorded, neither is queued twice.
    await ensureFootprints(deps, NOW);
    expect(jobs.sent).toHaveLength(4);
  });

  test('the footprints-load job runs through InlineJobs with the default handlers', async () => {
    const companyId = await companyIn('NE');
    await t.jobs.send('footprints-load', { companyId, state: 'NE' }, { singletonKey: 'NE' });
    await t.jobs.drain(t.deps);

    expect(t.jobs.errors).toEqual([]);
    expect(await footprintStateStatus(system(), 'NE')).toBe('ready');
    expect(await countFor('NE')).toBe(6);
    expect(await collectAll(t.footprints.features('NE'))).toHaveLength(6);
  });
});

describe('footprint table access', () => {
  test('app_tenant can read building_footprints but not write', async () => {
    await loadFootprintState(depsWith(new FakeFootprintSource()), 'NE', FIRST_ATTEMPT);
    const ctx = { companyId: t.seed.a.companyId, userId: null, role: 'system', canApproveSpend: false } as const;

    const read = await withTenant(t.deps.pools, ctx, async (tx) => {
      const result = await tx.execute(sql`select count(*)::int as n from building_footprints`);
      return (result.rows[0] as { n: number }).n;
    });
    expect(read).toBe(6);

    await expect(
      withTenant(t.deps.pools, ctx, async (tx) => {
        await tx.execute(
          sql`insert into building_footprints (state, geom, area_sq_ft, source)
              values ('NE', ST_GeomFromText('POLYGON((0 0,0 1,1 1,0 0))', 4326), 1, 'test')`,
        );
      }),
    ).rejects.toThrow();
    expect(await countFor('NE')).toBe(6);
  });
});

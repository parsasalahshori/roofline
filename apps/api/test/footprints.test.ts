import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { beforeEach, describe, expect, inject, test } from 'vitest';
import { footprintBoxDegrees, footprintsNear, footprintsNearQuery, withTenant } from '@roofline/db';
import {
  beatFootprintTile,
  claimFootprintTile,
  failFootprintTile,
  finishFootprintTile,
  footprintTileStatus,
  footprintTileStatuses,
  insertFootprints,
  LOAD_HEARTBEAT_STALE_MS,
  STALE_LOADING_MS,
  tilesNeedingRetry,
  type FootprintInput,
} from '@roofline/db/system';
import { quadkeyOf } from '@roofline/shared';
import type { AppDeps } from '../src/app.ts';
import { FOOTPRINT_BATCH_SIZE, FOOTPRINT_LOAD_FAILED_PLAIN, loadFootprintTile } from '../src/estimator/footprints-load.ts';
import type { PgBoss } from 'pg-boss';
import { ensureJobQueues, InlineJobs, jobQueueOptions, PgBossJobs } from '../src/jobs/queue.ts';
import { ensureFootprints } from '../src/jobs/scheduler/footprints-ensure.ts';
import { FakeFootprintSource } from '../src/providers/fakes/footprints.ts';
import type { FootprintFeature, FootprintSource } from '../src/providers/footprints.ts';
import { MicrosoftFootprints } from '../src/providers/ms-footprints.ts';
import { seedFootprintFixture } from '../src/scripts/footprint-fixture.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * The footprint loader (one zoom-9 quadkey tile at a time) and its lookups. The footprint tables are
 * global (no company id), and makeTestApp empties the whole database before every test, so nothing
 * leaks between tests. Raw counts are read through the owner connection, which sees every table.
 */

const NOW = new Date('2026-10-12T15:00:00.000Z');
const FIRST_ATTEMPT = { attempt: 1, lastAttempt: false } as const;
const LAST_ATTEMPT = { attempt: 5, lastAttempt: true } as const;
const NE_FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/footprints-ne.json', import.meta.url), 'utf8'),
) as FootprintFeature[];
/** The tile the six Omaha fixture buildings fall in. */
const OMAHA = quadkeyOf(NE_FIXTURE[0]!.ring[0]![0], NE_FIXTURE[0]!.ring[0]![1]);
/** Another tile (Iowa, east of Omaha), for loads of made-up buildings. */
const IOWA = quadkeyOf(-93.6, 41.6);

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
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

const countFor = async (tile: string) =>
  Number((await owner<{ n: string }>(`select count(*) as n from building_footprints where tile = $1`, [tile]))[0]!.n);

const tileRow = async (tile: string) =>
  (await owner<Record<string, unknown>>(`select * from building_footprint_tiles where quadkey = $1`, [tile]))[0];

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

/** A source that yields `count` squares (each a little east of the last) for any tile. */
function squaresSource(count: number): FootprintSource {
  return {
    configured: true,
    tileUrls: async (q) => [`https://custom.test/${q}.csv.gz`],
    async *features() {
      for (let i = 0; i < count; i++) yield { sourceRef: `sq-${i}`, ring: square(-93.6 + i * 0.0001, 41.6) };
    },
  };
}

/** A source that yields three good buildings and then throws text that must never be stored. */
function breakingSource(): FootprintSource {
  return {
    configured: true,
    tileUrls: async (q) => [`https://custom.test/${q}.csv.gz`],
    async *features() {
      for (let i = 0; i < 3; i++) yield { sourceRef: `ok-${i}`, ring: square(-96 + i * 0.001, 41) };
      throw new Error('PROVIDER SECRET TEXT');
    },
  };
}

/** The dataset's line format: one GeoJSON Feature per line, no id. */
const asLine = (ring: FootprintFeature['ring']) =>
  JSON.stringify({ type: 'Feature', properties: { height: -1, confidence: -1 }, geometry: { type: 'Polygon', coordinates: [ring] } });

/** A Microsoft source over a fake fetch: the index lists OMAHA (two files) and serves the fixture in them. */
function microsoftOverFixture(): { src: MicrosoftFootprints; urls: string[] } {
  const urls: string[] = [];
  const half = Math.ceil(NE_FIXTURE.length / 2);
  const files: Record<string, Buffer> = {
    'https://x.test/g/a.csv.gz': gzipSync(NE_FIXTURE.slice(0, half).map((f) => asLine(f.ring)).join('\n') + '\n'),
    'https://x.test/g/b.csv.gz': gzipSync(NE_FIXTURE.slice(half).map((f) => asLine(f.ring)).join('\n')),
  };
  const index = [
    'Location,QuadKey,Url,Size,UploadDate',
    `Canada,${OMAHA},https://x.test/g/not-us.csv.gz,1KB,2026-02-23`,
    `UnitedStates,${OMAHA},https://x.test/g/a.csv.gz,1KB,2026-02-23`,
    `UnitedStates,${OMAHA},https://x.test/g/b.csv.gz,1KB,2026-02-23`,
  ].join('\n');
  const f = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url === 'https://x.test/g/dataset-links.csv') return new Response(index);
    const body = files[url];
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(new Uint8Array(body));
  }) as unknown as typeof fetch;
  return { src: new MicrosoftFootprints({ baseUrl: 'https://x.test/g/', fetch: f }), urls };
}

const depsWith = (footprints: FootprintSource): AppDeps => ({ ...t.deps, footprints });

describe('loadFootprintTile', () => {
  test('the Microsoft source over the fixture files loads the tile', async () => {
    const { src, urls } = microsoftOverFixture();

    await loadFootprintTile(depsWith(src), OMAHA, FIRST_ATTEMPT);

    expect(await footprintTileStatus(system(), OMAHA)).toBe('ready');
    const row = await tileRow(OMAHA);
    expect(row).toMatchObject({
      status: 'ready',
      buildings: 6,
      error_plain: null,
      source_url: 'https://x.test/g/a.csv.gz https://x.test/g/b.csv.gz',
    });
    expect(row!.loaded_at).toBeInstanceOf(Date);
    expect(urls.filter((u) => u.endsWith('dataset-links.csv'))).toHaveLength(1);
    expect(urls).not.toContain('https://x.test/g/not-us.csv.gz');
    expect(await countFor(OMAHA)).toBe(6);
    const rows = await owner<{ area: string; valid: boolean; state: string | null }>(
      `select area_sq_ft::text as area, ST_IsValid(geom) as valid, state from building_footprints where tile = $1`,
      [OMAHA],
    );
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(Number(r.area)).toBeGreaterThan(100);
      expect(Number(r.area)).toBeLessThan(100000);
      expect(r.valid).toBe(true);
      // A tile spans state lines, so tile rows carry no state.
      expect(r.state).toBeNull();
    }
  });

  test('the fake source also loads the Omaha tile', async () => {
    await loadFootprintTile(depsWith(new FakeFootprintSource()), OMAHA, FIRST_ATTEMPT);
    expect(await footprintTileStatus(system(), OMAHA)).toBe('ready');
    expect(await countFor(OMAHA)).toBe(6);
    expect(await tileRow(OMAHA)).toMatchObject({ buildings: 6, source_url: `https://fake.test/footprints/${OMAHA}.csv.gz` });
  });

  test('a tile with no files is ready with no buildings', async () => {
    await loadFootprintTile(depsWith(new FakeFootprintSource()), IOWA, FIRST_ATTEMPT);
    expect(await tileRow(IOWA)).toMatchObject({ status: 'ready', buildings: 0, source_url: null });
  });

  test('a failing stream marks failed and leaves no rows', async () => {
    await expect(loadFootprintTile(depsWith(breakingSource()), OMAHA, LAST_ATTEMPT)).rejects.toThrow();

    expect(await footprintTileStatus(system(), OMAHA)).toBe('failed');
    expect(await countFor(OMAHA)).toBe(0);
    const row = await tileRow(OMAHA);
    expect(row!.error_plain).toBe(FOOTPRINT_LOAD_FAILED_PLAIN);
    expect(JSON.stringify(row)).not.toContain('SECRET');
  });

  test('a failing index download marks the tile failed', async () => {
    const src = new MicrosoftFootprints({ baseUrl: 'https://x.test/g/', fetch: (async () => new Response('SECRET', { status: 409 })) as unknown as typeof fetch });
    await expect(loadFootprintTile(depsWith(src), OMAHA, FIRST_ATTEMPT)).rejects.toThrow('409');
    expect(await tileRow(OMAHA)).toMatchObject({ status: 'failed', error_plain: FOOTPRINT_LOAD_FAILED_PLAIN });
  });

  test('a key that is not a zoom-9 quadkey returns quietly: nothing claimed, nothing thrown', async () => {
    const source = squaresSource(3);
    for (const key of ['NE', '01233', '0213323334', '021332339']) {
      await expect(loadFootprintTile(depsWith(source), key, FIRST_ATTEMPT)).resolves.toBe('skipped');
      expect(await tileRow(key)).toBeUndefined();
    }
  });

  test('a retry after a failure loads cleanly', async () => {
    await expect(loadFootprintTile(depsWith(breakingSource()), OMAHA, FIRST_ATTEMPT)).rejects.toThrow();
    expect(await footprintTileStatus(system(), OMAHA)).toBe('failed');

    await loadFootprintTile(depsWith(new FakeFootprintSource()), OMAHA, { attempt: 2, lastAttempt: false });

    expect(await footprintTileStatus(system(), OMAHA)).toBe('ready');
    expect(await countFor(OMAHA)).toBe(6);
    expect(await tileRow(OMAHA)).toMatchObject({ buildings: 6, error_plain: null });
  });

  test('loading over rows left by a crash replaces them, and leaves other tiles alone', async () => {
    const start = t.clock.now();
    expect(await claimFootprintTile(system(), OMAHA, start)).toBe(true);
    expect(await insertFootprints(system(), { tile: OMAHA, state: null }, [{ sourceRef: 'left-over', ring: square(-96, 41) }])).toBe(1);
    expect(await insertFootprints(system(), { tile: IOWA, state: null }, [{ sourceRef: 'other-tile', ring: square(-93.6, 41.6) }])).toBe(1);
    expect(await countFor(OMAHA)).toBe(1);

    // The crashed worker's claim is stale: a new job takes it over and replaces the rows.
    t.clock.set(new Date(start.getTime() + STALE_LOADING_MS + 1000));
    await loadFootprintTile(depsWith(new FakeFootprintSource()), OMAHA, FIRST_ATTEMPT);

    expect(await footprintTileStatus(system(), OMAHA)).toBe('ready');
    expect(await countFor(OMAHA)).toBe(6);
    const refs = await owner<{ source_ref: string }>(`select source_ref from building_footprints where tile = $1`, [OMAHA]);
    expect(refs.map((r) => r.source_ref)).not.toContain('left-over');
    expect(await countFor(IOWA)).toBe(1);
  });

  test('a load for a tile that is already loading does nothing', async () => {
    expect(await claimFootprintTile(system(), OMAHA, t.clock.now())).toBe(true);
    const fake = new FakeFootprintSource();
    await loadFootprintTile(depsWith(fake), OMAHA, FIRST_ATTEMPT);
    expect(await footprintTileStatus(system(), OMAHA)).toBe('loading');
    expect(await countFor(OMAHA)).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  test('a load takes over a claim whose heartbeat stopped (a process restarted mid-load), never a live one', async () => {
    const now = t.clock.now().getTime();
    // A claim that beat 50 seconds ago is alive: the load leaves it alone.
    expect(await claimFootprintTile(system(), OMAHA, new Date(now - LOAD_HEARTBEAT_STALE_MS + 10_000))).toBe(true);
    expect(await loadFootprintTile(depsWith(new FakeFootprintSource()), OMAHA, FIRST_ATTEMPT)).toBe('busy');
    // Its heartbeat stopped over a minute ago: the next load takes it over and finishes the tile.
    await beatFootprintTile(system(), OMAHA, new Date(now - LOAD_HEARTBEAT_STALE_MS - 10_000));
    expect(await loadFootprintTile(depsWith(new FakeFootprintSource()), OMAHA, FIRST_ATTEMPT)).toBe('loaded');
    expect(await footprintTileStatus(system(), OMAHA)).toBe('ready');
    expect(await countFor(OMAHA)).toBeGreaterThan(0);
  });

  test('a heartbeat moves only a loading claim forward', async () => {
    const start = new Date('2026-10-12T10:00:00.000Z');
    const later = new Date('2026-10-12T10:00:30.000Z');
    expect(await claimFootprintTile(system(), OMAHA, start)).toBe(true);
    await beatFootprintTile(system(), OMAHA, later);
    const [row] = await owner<{ started_at: Date }>(`select started_at from building_footprint_tiles where quadkey = $1`, [OMAHA]);
    expect(row!.started_at.toISOString()).toBe(later.toISOString());
    await finishFootprintTile(system(), OMAHA, 0, null, later);
    await beatFootprintTile(system(), OMAHA, new Date('2026-10-12T11:00:00.000Z'));
    const [after] = await owner<{ started_at: Date }>(`select started_at from building_footprint_tiles where quadkey = $1`, [OMAHA]);
    expect(after!.started_at.toISOString()).toBe(later.toISOString());
  });

  test('batches of 2,000', async () => {
    const count = FOOTPRINT_BATCH_SIZE * 2 + 1;
    expect(count).toBe(4001);
    await loadFootprintTile(depsWith(squaresSource(count)), IOWA, FIRST_ATTEMPT);
    expect(await footprintTileStatus(system(), IOWA)).toBe('ready');
    expect(await tileRow(IOWA)).toMatchObject({ buildings: 4001 });
    expect(await countFor(IOWA)).toBe(4001);
  });
});

describe('claimFootprintTile', () => {
  test('a second claim while loading is refused; a ready tile cannot be claimed; a stale claim can', async () => {
    const start = t.clock.now();
    expect(await claimFootprintTile(system(), OMAHA, start)).toBe(true);
    expect(await footprintTileStatus(system(), OMAHA)).toBe('loading');
    expect(await claimFootprintTile(system(), OMAHA, start)).toBe(false);

    // Just inside the limit it is still someone's.
    expect(await claimFootprintTile(system(), OMAHA, new Date(start.getTime() + STALE_LOADING_MS - 1000))).toBe(false);

    // Past the limit it is a crashed worker's, and can be taken again.
    expect(await claimFootprintTile(system(), OMAHA, new Date(start.getTime() + STALE_LOADING_MS + 1000))).toBe(true);

    await finishFootprintTile(system(), OMAHA, 0, null, start);
    expect(await footprintTileStatus(system(), OMAHA)).toBe('ready');
    expect(await claimFootprintTile(system(), OMAHA, new Date(start.getTime() + STALE_LOADING_MS * 10))).toBe(false);
  });

  test('a failed tile can be claimed again, and an unknown tile has no status', async () => {
    expect(await footprintTileStatus(system(), OMAHA)).toBeNull();
    expect(await claimFootprintTile(system(), OMAHA, NOW)).toBe(true);
    await failFootprintTile(system(), OMAHA, FOOTPRINT_LOAD_FAILED_PLAIN, NOW);
    expect(await footprintTileStatus(system(), OMAHA)).toBe('failed');
    expect(await claimFootprintTile(system(), OMAHA, NOW)).toBe(true);
    expect(await footprintTileStatus(system(), OMAHA)).toBe('loading');
    expect(await footprintTileStatuses(system(), [OMAHA, IOWA])).toEqual(new Map([[OMAHA, 'loading']]));
  });
});

describe('insertFootprints', () => {
  test('keeps only valid polygons and returns the count', async () => {
    const target = { tile: OMAHA, state: null };
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

    expect(await insertFootprints(system(), target, [normal])).toBe(1);
    expect(await insertFootprints(system(), target, [threePoints])).toBe(0);
    expect(await insertFootprints(system(), target, [])).toBe(0);
    const bowtieCount = await insertFootprints(system(), target, [bowtie]);
    expect(bowtieCount).toBeGreaterThanOrEqual(0);
    expect(bowtieCount).toBeLessThanOrEqual(1);

    expect(await countFor(OMAHA)).toBe(1 + bowtieCount);
    const invalid = await owner<{ n: string }>(`select count(*) as n from building_footprints where not ST_IsValid(geom)`);
    expect(Number(invalid[0]!.n)).toBe(0);
  });

  test('a seeded row keeps its state', async () => {
    expect(await insertFootprints(system(), { tile: null, state: 'ne' }, [{ sourceRef: 's', ring: square(-96, 41) }])).toBe(1);
    expect(await owner(`select state, tile from building_footprints`)).toEqual([{ state: 'NE', tile: null }]);
  });
});

describe('seedFootprintFixture', () => {
  test('files the fixture in its tile, marks it ready, and is idempotent', async () => {
    await seedFootprintFixture(t.deps.pools);
    await seedFootprintFixture(t.deps.pools);
    expect(await tileRow(OMAHA)).toMatchObject({ status: 'ready', buildings: 6 });
    expect(await countFor(OMAHA)).toBe(6);
  });
});

describe('ensureFootprints (retries)', () => {
  test('re-queues failed and stale tiles (singleton per quadkey), not ready or fresh ones', async () => {
    const jobs = new InlineJobs();
    const deps: AppDeps = { ...t.deps, jobs };
    const stale = quadkeyOf(-77.05, 38.93);
    const fresh = quadkeyOf(-118.25, 34.05);
    await claimFootprintTile(system(), OMAHA, NOW);
    await failFootprintTile(system(), OMAHA, FOOTPRINT_LOAD_FAILED_PLAIN, NOW);
    await claimFootprintTile(system(), stale, new Date(NOW.getTime() - STALE_LOADING_MS - 1000));
    await claimFootprintTile(system(), fresh, NOW);
    await loadFootprintTile(depsWith(new FakeFootprintSource()), IOWA, FIRST_ATTEMPT);

    expect((await tilesNeedingRetry(system(), NOW)).map((r) => r.quadkey)).toEqual([OMAHA, stale].sort());

    await ensureFootprints(deps, NOW);

    expect(jobs.sent.map((s) => s.name)).toEqual(['footprints-load', 'footprints-load']);
    expect(jobs.sent.map((s) => s.data.quadkey).sort()).toEqual([OMAHA, stale].sort());
    for (const s of jobs.sent) {
      expect(s.singletonKey).toBe(s.data.quadkey);
      expect([t.seed.a.companyId, t.seed.b.companyId]).toContain(s.data.companyId);
    }
  });

  test('the footprints-load job runs through InlineJobs with the default handlers', async () => {
    await t.jobs.send('footprints-load', { companyId: t.seed.a.companyId, quadkey: OMAHA, state: 'NE' }, { singletonKey: OMAHA });
    await t.jobs.drain(t.deps);

    expect(t.jobs.errors).toEqual([]);
    expect(await footprintTileStatus(system(), OMAHA)).toBe('ready');
    expect(await countFor(OMAHA)).toBe(6);
    expect(await collectAll(t.footprints.features(OMAHA))).toHaveLength(6);
  });

  test('a job queued before tiles (state only) does nothing', async () => {
    await t.jobs.send('footprints-load', { companyId: t.seed.a.companyId, state: 'NE' }, { singletonKey: 'NE' });
    await t.jobs.drain(t.deps);
    expect(t.jobs.errors).toEqual([]);
    expect(await owner(`select * from building_footprint_tiles`)).toEqual([]);
  });
});

describe('footprintsNear (C-C1)', () => {
  const ctx = () => ({ companyId: t.seed.a.companyId, userId: null, role: 'system', canApproveSpend: false }) as const;

  test('the box around the point covers the radius at every US latitude', () => {
    // A degree of longitude is about 111 km at the equator and about 36 km in northern Alaska.
    for (const lat of [19, 41, 49, 64, 71.4]) {
      const metresPerDegLng = 111_320 * Math.cos((lat * Math.PI) / 180);
      expect(footprintBoxDegrees(lat, 40) * metresPerDegLng).toBeGreaterThanOrEqual(40);
    }
    expect(footprintBoxDegrees(41, 0)).toBeGreaterThan(0);
  });

  test('finds the buildings near a point through the GIST index on geom', async () => {
    await insertFootprints(system(), { tile: OMAHA, state: null }, [
      { sourceRef: 'here', ring: square(-96, 41.25) },
      { sourceRef: 'far', ring: square(-95.9, 41.3) },
    ]);
    const near = await withTenant(t.deps.pools, ctx(), (tx) => footprintsNear(tx, [-95.9998, 41.2502], 40));
    expect(near).toHaveLength(1);
    expect(near[0]!.contains).toBe(true);

    const plan = await withTenant(t.deps.pools, ctx(), async (tx) => {
      // With a handful of rows the planner would scan anyway; turned off, an index-usable query shows its index.
      await tx.execute(sql`set local enable_seqscan = off`);
      const result = await tx.execute(sql`explain ${footprintsNearQuery([-95.9998, 41.2502], 40)}`);
      return result.rows.map((r) => String(Object.values(r)[0])).join('\n');
    });
    expect(plan).toContain('building_footprints_geom_gist');
  });
});

describe('the footprints-load queue expiry (C-M3)', () => {
  test('a footprint load may run about six hours; other jobs keep the default', async () => {
    expect(jobQueueOptions('footprints-load')).toMatchObject({ policy: 'stately', retryLimit: 4, expireInSeconds: 6 * 60 * 60 });
    expect(jobQueueOptions('signed-pdf')).not.toHaveProperty('expireInSeconds');

    const sends: { name: string; opts: Record<string, unknown> }[] = [];
    const created: { name: string; opts: Record<string, unknown> }[] = [];
    const boss = {
      send: async (name: string, _data: unknown, opts: Record<string, unknown>) => {
        sends.push({ name, opts });
        return 'id';
      },
      createQueue: async (name: string, opts: Record<string, unknown>) => {
        created.push({ name, opts });
      },
      getQueue: async () => ({ policy: 'stately' }),
    } as unknown as PgBoss;
    const jobs = new PgBossJobs(boss);
    await jobs.send('footprints-load', { companyId: t.seed.a.companyId, quadkey: OMAHA }, { singletonKey: OMAHA });
    await jobs.send('signed-pdf', { companyId: t.seed.a.companyId, proposalId: 'p' });
    expect(sends[0]).toEqual({ name: 'footprints-load', opts: { singletonKey: OMAHA, expireInSeconds: 21600 } });
    expect(sends[1]).toEqual({ name: 'signed-pdf', opts: {} });

    await ensureJobQueues(boss);
    expect(created.find((c) => c.name === 'footprints-load')!.opts).toMatchObject({ expireInSeconds: 21600 });
    expect(created.find((c) => c.name === 'import-customers')!.opts).not.toHaveProperty('expireInSeconds');
  });
});

describe('footprint table access', () => {
  test('app_tenant can read building_footprints but not write', async () => {
    await loadFootprintTile(depsWith(new FakeFootprintSource()), OMAHA, FIRST_ATTEMPT);
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
    await expect(
      withTenant(t.deps.pools, ctx, async (tx) => {
        await tx.execute(sql`select * from building_footprint_tiles`);
      }),
    ).rejects.toThrow();
    expect(await countFor(OMAHA)).toBe(6);
  });
});

import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { spotterReports } from '@roofline/db';
import { upsertSpotterReports } from '@roofline/db/system';
import { parseSpcHailCsv, syncSpotter } from '../src/storm/spotter.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const CSV = readFileSync(new URL('./fixtures/spc-hail.csv', import.meta.url), 'utf8');
const NOW = new Date('2026-10-12T15:00:00.000Z');
const BASE = 'https://www.spc.noaa.gov/climo/reports/';
const TODAY_URL = `${BASE}261012_rpts_hail.csv`;
const YESTERDAY_URL = `${BASE}261011_rpts_hail.csv`;

describe('parseSpcHailCsv', () => {
  test('a wrong header gives nothing', () => {
    expect(parseSpcHailCsv('Time,Size\n1523,100\n', '2026-10-12')).toEqual([]);
  });

  test('keeps the valid rows and skips unknown sizes and bad latitudes', () => {
    const rows = parseSpcHailCsv(CSV, '2026-10-12');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ timeUtc: '15:23:00', sizeIn: 1, state: 'NE', lat: 41.3, lon: -95.93, county: 'DOUGLAS' });
    expect(rows[1]).toMatchObject({ timeUtc: '16:10:00', sizeIn: 1.75, location: '5 W ELKHORN' });
  });

  test('a header-only file gives nothing', () => {
    expect(parseSpcHailCsv('Time,Size,Location,County,State,Lat,Lon,Comments\n', '2026-10-12')).toEqual([]);
  });
});

describe('syncSpotter', () => {
  let t: TestApp;
  // app_system holds SELECT and INSERT only on spotter_reports (Ruling BF), so the cleanup goes through the owner.
  const owner = new pg.Client({ connectionString: inject('dbUrls').owner });
  const ownerReady = owner.connect();

  afterAll(async () => {
    await ownerReady.catch(() => undefined);
    await owner.end().catch(() => undefined);
  });

  beforeEach(async () => {
    t = await makeTestApp();
    await ownerReady;
    await owner.query('delete from spotter_reports');
  });

  const store = (r: Parameters<typeof upsertSpotterReports>[1]) => upsertSpotterReports(t.deps.pools.system, r);

  const fakeFetch = (urls: string[], handler: (url: string) => Response) =>
    (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      return handler(url);
    }) as typeof fetch;

  test('stores new reports once and requests both days', async () => {
    const urls: string[] = [];
    const f = fakeFetch(urls, (url) => (url === TODAY_URL ? new Response(CSV) : new Response('', { status: 404 })));
    expect(await syncSpotter({ store, fetch: f }, NOW)).toEqual({ inserted: 2 });
    expect(await syncSpotter({ store, fetch: f }, NOW)).toEqual({ inserted: 0 });
    const rows = await t.deps.pools.system.select().from(spotterReports);
    expect(rows).toHaveLength(2);
    expect(urls.slice(0, 2)).toEqual([TODAY_URL, YESTERDAY_URL]);
  });

  test('two missing days store nothing', async () => {
    const f = fakeFetch([], () => new Response('', { status: 404 }));
    expect(await syncSpotter({ store, fetch: f }, NOW)).toEqual({ inserted: 0 });
  });

  test('a failing fetch stores nothing and does not throw', async () => {
    const f = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    expect(await syncSpotter({ store, fetch: f }, NOW)).toEqual({ inserted: 0 });
  });
});

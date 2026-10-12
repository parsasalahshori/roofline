import pg from 'pg';
import { afterAll, beforeEach, expect, inject, test } from 'vitest';
import { pruneEarlyReports } from '../src/jobs/scheduler/prune-early-reports.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * The early-report prune. Runs in the worker daily with the clock's `now`: an unapplied early
 * delivery report received more than 7 days before `now` is deleted, across companies; an applied
 * one, or a newer one, is kept. Rows are inserted and read through the owner connection, because
 * the tenant pools cannot write early_delivery_reports on another company's behalf.
 */

const NOW = new Date('2026-10-12T15:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

let t: TestApp;
let owner: pg.Client;

beforeEach(async () => {
  t = await makeTestApp();
  owner = new pg.Client({ connectionString: inject('dbUrls').owner });
  await owner.connect();
});

afterAll(async () => {
  await owner?.end().catch(() => undefined);
});

/** Inserts one early report by owner SQL and returns its id. Each SID is unique per test. */
async function insertReport(companyId: string, sid: string, receivedAt: Date, appliedAt: Date | null): Promise<string> {
  const res = await owner.query<{ id: string }>(
    `insert into early_delivery_reports (company_id, provider_message_sid, status, received_at, applied_at)
     values ($1, $2, 'delivered', $3, $4) returning id`,
    [companyId, sid, receivedAt, appliedAt],
  );
  return res.rows[0]!.id;
}

/** The ids still in the table among the rows this test inserted. */
async function remaining(ids: string[]): Promise<string[]> {
  const res = await owner.query<{ id: string }>('select id from early_delivery_reports where id = any($1::uuid[]) order by id', [ids]);
  return res.rows.map((r) => r.id);
}

test('the prune deletes stale unapplied reports across companies, keeps the rest, and a second run deletes nothing', async () => {
  const a = t.seed.a.companyId;
  const b = t.seed.b.companyId;

  const staleA = await insertReport(a, 'SMPRUNE-A-STALE', ago(8), null);
  const freshA = await insertReport(a, 'SMPRUNE-A-FRESH', ago(6), null);
  const appliedA = await insertReport(a, 'SMPRUNE-A-APPLIED', ago(8), ago(8));
  const staleB = await insertReport(b, 'SMPRUNE-B-STALE', ago(8), null);
  const all = [staleA, freshA, appliedA, staleB];

  await pruneEarlyReports(t.deps, NOW);

  expect(await remaining(all)).toEqual([freshA, appliedA].sort());

  await pruneEarlyReports(t.deps, NOW);

  expect(await remaining(all)).toEqual([freshA, appliedA].sort());
});

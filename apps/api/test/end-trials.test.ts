import pg from 'pg';
import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { endTrials } from '../src/jobs/scheduler/end-trials.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * The trial-end job. Runs in the worker every 5 minutes with the clock's `now`: a company still in
 * `trial` whose `trial_ends_at` has passed becomes `trial_ended`, with one `billing.trial_ended`
 * audit row. Rows are read through the owner connection because RLS hides audit_log from the
 * tenant pools in this file.
 */

const NOW = new Date('2026-10-12T15:00:00.000Z');
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

let t: TestApp;
let owner: pg.Client;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  owner = new pg.Client({ connectionString: inject('dbUrls').owner });
  await owner.connect();
});

afterAll(async () => {
  await owner?.end().catch(() => undefined);
});

const idOf = (company: 'a' | 'b') => t.seed[company].companyId;

/** Sets a company's billing status and trial end by owner SQL, bypassing the tenant grants. */
async function setCompany(company: 'a' | 'b', status: string, trialEndsAt: Date | null) {
  await owner.query('update companies set status = $1, trial_ends_at = $2 where id = $3', [status, trialEndsAt, idOf(company)]);
}

async function statusOf(company: 'a' | 'b'): Promise<string> {
  const row = await owner.query<{ status: string }>('select status from companies where id = $1', [idOf(company)]);
  return row.rows[0]!.status;
}

/** The `billing.trial_ended` audit rows for one company, read through the owner connection. */
async function trialEndedRows(company: 'a' | 'b') {
  const res = await owner.query<{ company_id: string; action: string; target_type: string; target_id: string }>(
    'select * from audit_log where action = $1 and company_id = $2',
    ['billing.trial_ended', idOf(company)],
  );
  return res.rows;
}

describe('end-trials', () => {
  test('a trial that ran out ends and is audited once', async () => {
    await setCompany('a', 'trial', at(-MINUTE));

    await endTrials(t.deps, NOW);

    expect(await statusOf('a')).toBe('trial_ended');
    const rows = await trialEndedRows('a');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'billing.trial_ended', target_type: 'company', target_id: idOf('a') });
  });

  test('a trial with time left and an active company are untouched', async () => {
    await setCompany('a', 'trial', at(DAY));
    await setCompany('b', 'active', at(-DAY));

    await endTrials(t.deps, NOW);

    expect(await statusOf('a')).toBe('trial');
    expect(await statusOf('b')).toBe('active');
    expect(await trialEndedRows('a')).toHaveLength(0);
    expect(await trialEndedRows('b')).toHaveLength(0);
  });

  test('a second run changes nothing', async () => {
    await setCompany('a', 'trial', at(-MINUTE));

    await endTrials(t.deps, NOW);
    await endTrials(t.deps, NOW);

    expect(await statusOf('a')).toBe('trial_ended');
    expect(await trialEndedRows('a')).toHaveLength(1);
  });
});

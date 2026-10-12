import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { createPools, type Pools } from '../src/pools.ts';
import { claimNowAlert, getAlertFacts, listAlertRecipients, listSettleCandidates } from '../src/repos/storm-alerts.ts';
import { upsertCompanyStorm } from '../src/repos/company-storms.ts';
import { type Tx, withTenant } from '../src/tenant.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';
import { insertOmahaStorm, type Query } from './fixtures/storms.ts';

const urls = inject('dbUrls');

let owner: pg.Pool;
let pools: Pools;
let seed: { a: SeededCompany; b: SeededCompany };

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

const asCompany = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(pools, { companyId, userId: null, role: 'system', canApproveSpend: false }, fn);

const NOW = new Date('2026-05-02T12:00:00Z');

/** Makes a storm on `day` and the company's storm row for it; returns both ids. */
async function matchStorm(companyId: string, day: string) {
  const stormId = await insertOmahaStorm(q, day);
  const { companyStorm } = await asCompany(companyId, (tx) =>
    upsertCompanyStorm(tx, { stormId, maxIn: 1.5, customersHit: 3, homesHit: 7, now: NOW }),
  );
  return { stormId, companyStormId: companyStorm.id };
}

beforeAll(async () => {
  owner = new pg.Pool({ connectionString: urls.owner });
  pools = createPools({ tenant: urls.tenant, system: urls.system });
});

afterAll(async () => {
  await pools?.end();
  await owner?.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

describe('storm alert repos', () => {
  test('claimNowAlert is true once, then false', async () => {
    const { companyStormId } = await matchStorm(seed.a.companyId, '2026-05-01');
    expect(await asCompany(seed.a.companyId, (tx) => claimNowAlert(tx, companyStormId, NOW))).toBe(true);
    expect(await asCompany(seed.a.companyId, (tx) => claimNowAlert(tx, companyStormId, NOW))).toBe(false);
    const rows = await q(`select alerted_at from company_storms where id = $1`, [companyStormId]);
    expect(new Date(rows[0]!.alerted_at as string)).toEqual(NOW);
  });

  test('getAlertFacts reads the company storm with its place, and nothing for another company', async () => {
    const { companyStormId, stormId } = await matchStorm(seed.a.companyId, '2026-05-01');
    await q(`update storms set place_name = 'Omaha, NE' where id = $1`, [stormId]);
    expect(await asCompany(seed.a.companyId, (tx) => getAlertFacts(tx, companyStormId))).toEqual({
      id: companyStormId,
      stormId,
      maxIn: 1.5,
      customersHit: 3,
      homesHit: 7,
      planTaskId: null,
      placeName: 'Omaha, NE',
    });
    expect(await asCompany(seed.b.companyId, (tx) => getAlertFacts(tx, companyStormId))).toBeNull();
  });

  test('listAlertRecipients returns only active owner and office members with storm_alert_email on', async () => {
    // owner on (default), office off, rep on, a second disabled owner on.
    await q(
      `update memberships set storm_alert_email = false
        where company_id = $1 and role = 'office'`,
      [seed.a.companyId],
    );
    await q(
      `update memberships set storm_alert_email = true
        where company_id = $1 and role = 'rep'`,
      [seed.a.companyId],
    );
    const disabledUser = await q(
      `insert into users (email, name, password_hash) values ('gone@a.test', 'Gone Owner', 'x') returning id`,
    );
    await q(
      `insert into memberships (company_id, user_id, role, status, storm_alert_email)
       values ($1, $2, 'owner', 'disabled', true)`,
      [seed.a.companyId, disabledUser[0]!.id],
    );
    const recipients = await asCompany(seed.a.companyId, (tx) => listAlertRecipients(tx));
    expect(recipients.map((r) => r.email)).toEqual(['owner@a.test']);
    expect(recipients[0]!.name).toEqual(expect.any(String));
  });

  test('listSettleCandidates reports planStatus draft, other and null, and skips dismissed storms and days outside the list', async () => {
    const draft = await matchStorm(seed.a.companyId, '2026-05-01');
    const other = await matchStorm(seed.a.companyId, '2026-05-01');
    const none = await matchStorm(seed.a.companyId, '2026-05-01');
    const dismissed = await matchStorm(seed.a.companyId, '2026-05-01');
    const outside = await matchStorm(seed.a.companyId, '2026-04-20');
    const task = async (status: string) =>
      (
        await q(
          `insert into agent_tasks (company_id, agent, kind, title, status) values ($1, 'system', 'storm_plan', 't', $2) returning id`,
          [seed.a.companyId, status],
        )
      )[0]!.id as string;
    const draftTask = await task('draft');
    const otherTask = await task('approved');
    await q(`update company_storms set plan_task_id = $2 where id = $1`, [draft.companyStormId, draftTask]);
    await q(`update company_storms set plan_task_id = $2 where id = $1`, [other.companyStormId, otherTask]);
    await q(`update company_storms set status = 'dismissed' where id = $1`, [dismissed.companyStormId]);

    const rows = await asCompany(seed.a.companyId, (tx) => listSettleCandidates(tx, ['2026-05-01']));
    const byId = new Map(rows.map((r) => [r.companyStormId, r]));
    expect(rows).toHaveLength(3);
    expect(byId.get(draft.companyStormId)).toMatchObject({ planStatus: 'draft', planTaskId: draftTask, status: 'new' });
    expect(byId.get(other.companyStormId)).toMatchObject({ planStatus: 'other', planTaskId: otherTask });
    expect(byId.get(none.companyStormId)).toMatchObject({ planStatus: null, planTaskId: null, stormStatus: 'provisional' });
    expect(byId.get(none.companyStormId)!.lastGrewAt).toBeInstanceOf(Date);
    expect(byId.has(dismissed.companyStormId)).toBe(false);
    expect(byId.has(outside.companyStormId)).toBe(false);
    expect(await asCompany(seed.a.companyId, (tx) => listSettleCandidates(tx, []))).toEqual([]);
    expect(await asCompany(seed.b.companyId, (tx) => listSettleCandidates(tx, ['2026-05-01']))).toEqual([]);
  });
});

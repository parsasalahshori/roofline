import pg from 'pg';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';
import { billMonthlyFees } from '../src/jobs/scheduler/bill-monthly-fees.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const PN_SID = 'PN' + 'a'.repeat(32);
const QE_SID = 'QE' + 'b'.repeat(32);

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

afterEach(async () => {
  await t.close();
});

/** Runs SQL as the owner role, which bypasses row-level security. */
async function ownerQuery<R extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<R[]> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    const res = await client.query<R>(sql, params);
    return res.rows;
  } finally {
    await client.end();
  }
}

/** The monthly fee rows Acme has, in a fixed order. */
function monthlyFees(): Promise<{ ref_type: string; ref_id: string; description: string }[]> {
  return ownerQuery<{ ref_type: string; ref_id: string; description: string }>(
    `select ref_type, ref_id, description from usage_events
      where company_id = $1 and ref_type in ('phone_number', 'texting_campaign_month')
      order by ref_type, ref_id`,
    [t.seed.a.companyId],
  );
}

describe('texting monthly fees', () => {
  test('monthly fees are recorded once per month', async () => {
    const companyId = t.seed.a.companyId;
    await ownerQuery(
      `insert into company_phone_numbers (company_id, e164, capabilities, provider_sid, purpose, status)
       values ($1, '+14025550100', '{sms,voice}', $2, 'main', 'active')`,
      [companyId, PN_SID],
    );
    await ownerQuery(
      "update texting_registrations set campaign_status = 'approved', campaign_sid = $2 where company_id = $1",
      [companyId, QE_SID],
    );

    t.clock.set(new Date('2026-11-01T12:00:00Z'));
    await billMonthlyFees(t.deps, t.clock.now());
    await billMonthlyFees(t.deps, t.clock.now());

    expect(await monthlyFees()).toEqual([
      {
        ref_type: 'phone_number',
        ref_id: `${PN_SID}:2026-11`,
        description: 'Texting number (402) 555-0100 — November 2026',
      },
      {
        ref_type: 'texting_campaign_month',
        ref_id: `${QE_SID}:2026-11`,
        description: 'Texting registration: monthly carrier fee — November 2026',
      },
    ]);

    t.clock.set(new Date('2026-12-01T12:00:00Z'));
    await billMonthlyFees(t.deps, t.clock.now());

    const after = await monthlyFees();
    expect(after.map((r) => r.ref_id)).toEqual([
      `${PN_SID}:2026-11`,
      `${PN_SID}:2026-12`,
      `${QE_SID}:2026-11`,
      `${QE_SID}:2026-12`,
    ]);
    expect(after[1]!.description).toBe('Texting number (402) 555-0100 — December 2026');
    expect(after[3]!.description).toBe('Texting registration: monthly carrier fee — December 2026');
    expect(t.logged).toEqual([]);
  });
});

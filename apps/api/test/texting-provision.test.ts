import pg from 'pg';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';
import { decrypt } from '@roofline/db';
import { loadRegistration, signingTokenFor } from '@roofline/db/system';
import { provisionTexting } from '../src/jobs/scheduler/provision-texting.ts';
import { createRegistrar } from '../src/providers/registrar.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from './helpers.ts';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

afterEach(async () => {
  await t.close();
});

/** Runs a statement as the owner role, which bypasses row-level security. */
async function ownerQuery(sql: string, params: unknown[] = []): Promise<void> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    await client.query(sql, params);
  } finally {
    await client.end();
  }
}

/** The ensureSubaccount calls the registrar took for one company. */
function subaccountCallsFor(companyId: string): unknown[] {
  return t.registrar.calls.filter((c) => c.method === 'ensureSubaccount' && c.args[0] === companyId);
}

describe('texting subaccount at sign-up', () => {
  test('a new company gets a texting subaccount, once', async () => {
    const id = t.seed.a.companyId;

    await provisionTexting(t.deps, new Date());
    await provisionTexting(t.deps, new Date());

    expect(subaccountCallsFor(id)).toHaveLength(1);

    const row = await loadRegistration(t.deps.pools.system, id);
    expect(row?.subaccountSid).toBeTruthy();
    expect(row?.subaccountAuthTokenEncrypted).toBeTruthy();
    const token = decrypt(row!.subaccountAuthTokenEncrypted!, TEST_ENCRYPTION_KEY);
    expect(token).toBe('fake-token-' + id.slice(0, 8));
    expect(await signingTokenFor(t.deps.pools.system, id, undefined, TEST_ENCRYPTION_KEY)).toBe(token);
  });

  test("nothing happens when texting isn't set up", async () => {
    const id = t.seed.a.companyId;
    const unconfigured = createRegistrar({ ...t.deps.config, FAKE_PROVIDERS: false });
    expect(unconfigured.configured).toBe(false);

    await expect(provisionTexting({ ...t.deps, registrar: unconfigured }, new Date())).resolves.toBeUndefined();

    expect((await loadRegistration(t.deps.pools.system, id))?.subaccountSid ?? null).toBeNull();
    expect(t.registrar.calls.filter((c) => c.method === 'ensureSubaccount')).toEqual([]);
  });

  test('canceled companies are skipped', async () => {
    const id = t.seed.a.companyId;
    await ownerQuery("update companies set status = 'canceled' where id = $1", [id]);

    await provisionTexting(t.deps, new Date());

    expect(subaccountCallsFor(id)).toEqual([]);
    expect((await loadRegistration(t.deps.pools.system, id))?.subaccountSid ?? null).toBeNull();
  });
});

import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { encrypt } from '../src/crypto.ts';
import { createPools } from '../src/pools.ts';
import { companies, companyPhoneNumbers, textingRegistrations } from '../src/schema/index.ts';
import { activeMainNumber } from '../src/system/index.ts';
import { companyIdForNumber, signingTokenFor } from '../src/system/routing.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';

const urls = inject('dbUrls');
const pools = createPools({ tenant: urls.tenant, system: urls.system });
const { system } = pools;

/** Not secrets: 32 bytes of 0x01 and of 0x02, base64. */
const KEY = Buffer.alloc(32, 1).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 2).toString('base64');

let seed: { a: SeededCompany; b: SeededCompany };

afterAll(async () => {
  await pools.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

describe('companyIdForNumber', () => {
  test('finds the company that owns an active number', async () => {
    await system.insert(companyPhoneNumbers).values([
      { companyId: seed.a.companyId, e164: '+14025550100', capabilities: ['sms'] },
      { companyId: seed.b.companyId, e164: '+14025550200', capabilities: ['sms'] },
    ]);
    expect(await companyIdForNumber(system, '+14025550100')).toBe(seed.a.companyId);
    expect(await companyIdForNumber(system, '+14025550200')).toBe(seed.b.companyId);
  });

  test('an unknown number is null', async () => {
    expect(await companyIdForNumber(system, '+14025550100')).toBeNull();
  });

  test('a number that is not active is null', async () => {
    await system.insert(companyPhoneNumbers).values({ companyId: seed.a.companyId, e164: '+14025550100', status: 'released' });
    expect(await companyIdForNumber(system, '+14025550100')).toBeNull();
  });

  test('the company phone on the profile (companies.phone_e164) is not a texting number', async () => {
    expect(await companyIdForNumber(system, seed.a.phoneE164)).toBeNull();
  });
});

describe('signingTokenFor', () => {
  const setToken = (companyId: string, token: Buffer | null) =>
    system
      .update(textingRegistrations)
      .set({ subaccountAuthTokenEncrypted: token })
      .where(eq(textingRegistrations.companyId, companyId));

  test('the decrypted subaccount token, ahead of the fallback', async () => {
    await setToken(seed.a.companyId, encrypt('token-for-a', KEY));
    expect(await signingTokenFor(system, seed.a.companyId, 'master-token', KEY)).toBe('token-for-a');
    expect(await signingTokenFor(system, seed.a.companyId, undefined, KEY)).toBe('token-for-a');
  });

  test('no stored token: the fallback (TWILIO_AUTH_TOKEN)', async () => {
    expect(await signingTokenFor(system, seed.a.companyId, 'master-token', KEY)).toBe('master-token');
  });

  test('no registration row at all: the fallback', async () => {
    // As the owner: app_system never deletes a registration.
    const owner = new pg.Client({ connectionString: urls.owner });
    await owner.connect();
    try {
      await owner.query('delete from texting_registrations where company_id = $1', [seed.a.companyId]);
    } finally {
      await owner.end();
    }
    expect(await signingTokenFor(system, seed.a.companyId, 'master-token', KEY)).toBe('master-token');
  });

  test('neither: null', async () => {
    expect(await signingTokenFor(system, seed.a.companyId, undefined, KEY)).toBeNull();
    expect(await signingTokenFor(system, seed.a.companyId, '', KEY)).toBeNull();
  });

  test("each company gets its own token, never another's", async () => {
    await setToken(seed.a.companyId, encrypt('token-for-a', KEY));
    await setToken(seed.b.companyId, encrypt('token-for-b', KEY));
    expect(await signingTokenFor(system, seed.b.companyId, undefined, KEY)).toBe('token-for-b');
  });

  test('a stored token that does not decrypt throws: it never falls back to the master token', async () => {
    await setToken(seed.a.companyId, encrypt('token-for-a', OTHER_KEY));
    await expect(signingTokenFor(system, seed.a.companyId, 'master-token', KEY)).rejects.toThrow();
  });
});

describe('activeMainNumber', () => {
  test("the company's own active main number, with its time zone; never another company's", async () => {
    await system.insert(companyPhoneNumbers).values([
      { companyId: seed.a.companyId, e164: '+14025550102', capabilities: ['sms'], purpose: 'main', status: 'released', providerSid: 'PN-old' },
      { companyId: seed.b.companyId, e164: '+14025550200', capabilities: ['sms'], purpose: 'main', providerSid: 'PN-b' },
    ]);
    expect(await activeMainNumber(system, seed.a.companyId)).toBeNull();

    await system
      .insert(companyPhoneNumbers)
      .values({ companyId: seed.a.companyId, e164: '+14025550100', capabilities: ['sms'], purpose: 'main', providerSid: 'PN-a' });
    const [a] = await system.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, seed.a.companyId));
    expect(await activeMainNumber(system, seed.a.companyId)).toEqual({ e164: '+14025550100', providerSid: 'PN-a', timezone: a!.timezone });
    expect((await activeMainNumber(system, seed.b.companyId))?.providerSid).toBe('PN-b');
  });
});

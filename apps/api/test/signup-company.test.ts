import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { makeTestApp, SIGNUP_COMPANY, type TestApp } from './helpers.ts';

const PASSWORD = 'a long enough password';
const PHONE_MESSAGE = "That doesn't look like a US phone number.";
const SQUARE_METERS_40_MILES = Math.PI * 64373.76 ** 2;

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

/** A read-only look at the database through the system pool's raw client. */
async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await t.deps.pools.system.$client.query(text, params);
  return result.rows as T[];
}

function signup(overrides: Record<string, unknown> = {}) {
  return request(t.app)
    .post('/api/auth/signup')
    .send({
      email: 'owner@example.com',
      password: PASSWORD,
      name: 'Olive Owner',
      companyName: 'Summit Roofing',
      ...SIGNUP_COMPANY,
      ...overrides,
    });
}

describe('sign-up with company details', () => {
  test('sign-up sets the company up from the address', async () => {
    const res = await signup();
    expect(res.status).toBe(201);

    const [row] = await sql<Record<string, unknown>>(
      `select phone_e164, address_street, address_city, address_state, address_zip, timezone, service_area_miles,
              ST_Contains(service_area, location) as inside,
              ST_Area(service_area::geography) as area
         from companies where id = $1`,
      [res.body.company.id],
    );
    expect(row).toMatchObject({
      phone_e164: '+14025550199',
      address_street: '1200 Farnam St',
      address_city: 'Omaha',
      address_state: 'NE',
      address_zip: '68102',
      timezone: 'America/Chicago',
      service_area_miles: 40,
      inside: true,
    });
    const area = Number(row!.area);
    expect(Math.abs(area / SQUARE_METERS_40_MILES - 1)).toBeLessThan(0.02);
  });

  test('a New York address gets the New York time zone', async () => {
    const res = await signup({ companyAddress: '1 Main St, Albany, NY 12207' });
    expect(res.status).toBe(201);

    const [row] = await sql<{ timezone: string }>('select timezone from companies where id = $1', [res.body.company.id]);
    expect(row!.timezone).toBe('America/New_York');
  });

  test("an address we can't find still creates the account, unlocated", async () => {
    const typed = '1 Nowhere Rd, Omaha, NE 68102';
    const res = await signup({ companyAddress: typed });
    expect(res.status).toBe(201);

    const [row] = await sql<{ address_street: string; has_location: boolean; timezone: string }>(
      `select address_street, (location is not null) as has_location, timezone
         from companies where id = $1`,
      [res.body.company.id],
    );
    const [defaults] = await sql<{ expr: string }>(
      `select pg_get_expr(d.adbin, d.adrelid) as expr
         from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
        where d.adrelid = 'companies'::regclass and a.attname = 'timezone'`,
    );
    expect(row!.has_location).toBe(false);
    expect(row!.address_street).toBe(typed);
    // The column default is written as 'America/Chicago'::text; compare the text inside the quotes.
    expect(row!.timezone).toBe(/^'(.*)'::/.exec(defaults!.expr)?.[1]);
  });

  test('sign-up gives the map 2 seconds', async () => {
    const res = await signup({ companyAddress: '1200 Farnam St, Omaha, NE 68102' });
    expect(res.status).toBe(201);

    const lookups = t.geocoder.calls.filter((c) => c.method === 'geocode');
    expect(lookups.at(-1)?.args[1]).toEqual({ timeoutMs: 2000 });
  });

  test('when the map service is down, sign-up still works', async () => {
    const typed = '12 Outage Ave, Omaha, NE 68102';
    const res = await signup({ companyAddress: typed });
    expect(res.status).toBe(201);

    const [row] = await sql<{ address_street: string; has_location: boolean }>(
      'select address_street, (location is not null) as has_location from companies where id = $1',
      [res.body.company.id],
    );
    expect(row!.has_location).toBe(false);
    expect(row!.address_street).toBe(typed);
  });

  test('a bad business phone is a field error', async () => {
    const res = await signup({ companyPhone: '12' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: PHONE_MESSAGE, field: 'companyPhone' });
  });

  test('Google sign-up asks for the company details too', async () => {
    t.google.register('credential-new-google-user', {
      sub: 'google-sub-new-company',
      email: 'nora@example.com',
      emailVerified: true,
      name: 'Nora Newcomer',
    });
    const res = await request(t.app)
      .post('/api/auth/google')
      .send({ credential: 'credential-new-google-user', companyName: 'Summit Roofing' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ field: 'companyPhone' });
  });
});

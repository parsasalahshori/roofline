import pg from 'pg';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';
import { unsubscribeKey } from '../src/public/unsubscribe-key.ts';
import { signUnsubscribeToken } from '../src/public/unsubscribe-token.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * Postmark's bounce and complaint webhook (hooks/postmark.ts): basic auth with
 * POSTMARK_WEBHOOK_SECRET, then a complaint or hard bounce opts out the address its unsubscribe
 * token names.
 */

const SECRET = 'pm-hook-secret-0123456789';
const HOOK = '/hooks/postmark';
const EMAIL = 'pat@example.com';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp({ POSTMARK_WEBHOOK_SECRET: SECRET });
});

afterEach(async () => {
  await t.close();
});

const A = () => t.seed.a.companyId;
const B = () => t.seed.b.companyId;

const basic = (password: string, user = 'postmark') => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

function tokenFor(companyId: string, email = EMAIL): string {
  return signUnsubscribeToken(unsubscribeKey(t.deps.config), { companyId, email });
}

function event(recordType: string, token: string | undefined, extra: Record<string, unknown> = {}) {
  return {
    RecordType: recordType,
    Email: 'someone-else@example.com',
    Description: 'provider text that is never kept',
    ...(token === undefined ? {} : { Metadata: { unsubscribe: token } }),
    ...extra,
  };
}

const send = (body: unknown, auth: string | null = basic(SECRET)) => {
  const req = request(t.app).post(HOOK);
  if (auth !== null) req.set('Authorization', auth);
  return req.send(body as object);
};

async function rowsFor(companyId: string): Promise<{ email: string; source: string }[]> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    const res = await client.query<{ email: string; source: string }>(
      'select email, source from email_opt_outs where company_id = $1 order by email',
      [companyId],
    );
    return res.rows;
  } finally {
    await client.end();
  }
}

describe('authentication', () => {
  test('a wrong secret, a missing header and a malformed header answer 401 and record nothing', async () => {
    const body = event('SpamComplaint', tokenFor(A()));
    for (const auth of [basic('wrong-secret-0123456789'), null, 'Basic !!!', 'Bearer abc', basic('')]) {
      const res = await send(body, auth);
      expect(res.status).toBe(401);
      expect(res.text).toBe('');
      expect(res.headers['www-authenticate']).toBe('Basic realm="postmark"');
    }
    expect(await rowsFor(A())).toEqual([]);
  });

  test('any user name is accepted with the right secret', async () => {
    const res = await send(event('SpamComplaint', tokenFor(A())), basic(SECRET, 'whoever'));
    expect(res.status).toBe(200);
    expect(await rowsFor(A())).toHaveLength(1);
  });

  test('an app with no secret set refuses every call', async () => {
    await t.close();
    t = await makeTestApp({ POSTMARK_WEBHOOK_SECRET: undefined });
    const res = await send(event('SpamComplaint', tokenFor(A())));
    expect(res.status).toBe(401);
    expect(await rowsFor(A())).toEqual([]);
  });
});

describe('what is acted on', () => {
  test('a spam complaint records one complaint row for the token address, not the payload address', async () => {
    const res = await send(event('SpamComplaint', tokenFor(A())));
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
    expect(await rowsFor(A())).toEqual([{ email: EMAIL, source: 'complaint' }]);
  });

  test('a hard bounce records too', async () => {
    const res = await send(event('Bounce', tokenFor(A()), { Type: 'HardBounce' }));
    expect(res.status).toBe(200);
    expect(await rowsFor(A())).toEqual([{ email: EMAIL, source: 'complaint' }]);
  });

  test('a soft bounce, a delivery and a bounce with no type record nothing', async () => {
    for (const body of [
      event('Bounce', tokenFor(A()), { Type: 'SoftBounce' }),
      event('Delivery', tokenFor(A())),
      event('Bounce', tokenFor(A())),
    ]) {
      expect((await send(body)).status).toBe(200);
    }
    expect(await rowsFor(A())).toEqual([]);
  });

  test('a forged token, a token from another secret, a bad token and no metadata record nothing', async () => {
    const [payload] = tokenFor(A()).split('.');
    const other = signUnsubscribeToken('a-different-secret-that-is-not-ours-0123', { companyId: A(), email: EMAIL });
    for (const token of [`${payload}.${'A'.repeat(43)}`, other, 'garbage', undefined]) {
      const res = await send(event('SpamComplaint', token));
      expect(res.status).toBe(200);
      expect(res.text).toBe('');
    }
    expect(await rowsFor(A())).toEqual([]);
  });

  test('a repeat delivery leaves exactly one row', async () => {
    const body = event('SpamComplaint', tokenFor(A()));
    expect((await send(body)).status).toBe(200);
    expect((await send(body)).status).toBe(200);
    expect(await rowsFor(A())).toHaveLength(1);
  });

  test('a token for company A never writes a row for company B', async () => {
    await send(event('SpamComplaint', tokenFor(A())));
    expect(await rowsFor(B())).toEqual([]);
    expect(await rowsFor(A())).toHaveLength(1);
  });
});

describe('bad bodies', () => {
  test('invalid JSON and a non-object body answer 400 with an empty body', async () => {
    const broken = await request(t.app)
      .post(HOOK)
      .set('Authorization', basic(SECRET))
      .set('Content-Type', 'application/json')
      .send('{"RecordType":');
    expect(broken.status).toBe(400);
    expect(broken.text).toBe('');

    const array = await send([1, 2]);
    expect(array.status).toBe(400);
    expect(array.text).toBe('');
  });
});

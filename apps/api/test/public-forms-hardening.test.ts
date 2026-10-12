import pg from 'pg';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';
import { insertOmahaStorm } from '@roofline/db/testing';
import { MESSAGES } from '../src/errors.ts';
import { PUBLIC_PAGE_RATE_LIMIT_PER_MIN, POSTMARK_HOOK_RATE_LIMIT_PER_MIN } from '../src/rate-limit.ts';
import { unsubscribeKey } from '../src/public/unsubscribe-key.ts';
import { signUnsubscribeToken } from '../src/public/unsubscribe-token.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * Ruling BF: the two public forms must work in a real browser. helmet's no-referrer makes a browser
 * post a form with `Origin: null`, which both Origin guards refuse (and must keep refusing), so the
 * pages that hold the forms answer `Referrer-Policy: same-origin`. Also: the public routes outside
 * /api are limited per IP address.
 */

const A_HOST = 'acme-roofing.roofline.test';
const CODE = 'abcd2345';
const EMAIL = 'pat@example.com';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

afterEach(async () => {
  await t.close();
});

async function makeStormPage(): Promise<void> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    const q = async (text: string, values?: unknown[]) => (await client.query(text, values)).rows;
    const stormId = await insertOmahaStorm(q, '2026-10-10');
    const [cs] = await q('insert into company_storms (company_id, storm_id, max_in) values ($1, $2, $3) returning id', [
      t.seed.a.companyId,
      stormId,
      1.5,
    ]);
    await q('insert into storm_pages (company_id, company_storm_id, code, active_until) values ($1, $2, $3, $4)', [
      t.seed.a.companyId,
      cs!.id,
      CODE,
      new Date(t.clock.now().getTime() + 30 * 86_400_000),
    ]);
  } finally {
    await client.end();
  }
}

const token = () => signUnsubscribeToken(unsubscribeKey(t.deps.config), { companyId: t.seed.a.companyId, email: EMAIL });

describe('Referrer-Policy and Origin: null', () => {
  test('the unsubscribe confirm page answers same-origin', async () => {
    const res = await request(t.app).get(`/u/${token()}`);
    expect(res.status).toBe(200);
    expect(res.headers['referrer-policy']).toBe('same-origin');
  });

  test('the storm page answers same-origin', async () => {
    await makeStormPage();
    const res = await request(t.app).get(`/storm/${CODE}`).set('Host', A_HOST);
    expect(res.status).toBe(200);
    expect(res.headers['referrer-policy']).toBe('same-origin');
  });

  test('a POST to the unsubscribe link with Origin: null is refused and records nothing', async () => {
    const res = await request(t.app)
      .post(`/u/${token()}`)
      .set('Origin', 'null')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('');
    expect(res.status).toBe(403);
  });

  test('a POST to the storm form with Origin: null is refused', async () => {
    await makeStormPage();
    const res = await request(t.app)
      .post(`/api/public/storm-requests/${CODE}`)
      .set('Origin', 'null')
      .send({ name: 'Lee', phone: '4025550143', address: '7421 Cedar Ridge Dr, Omaha, NE 68114' });
    expect(res.status).toBe(403);
  });

  test('the one-click unsubscribe POST with no Origin still works', async () => {
    const res = await request(t.app)
      .post(`/u/${token()}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('List-Unsubscribe=One-Click');
    expect(res.status).toBe(200);
    expect(res.text).toBe('Unsubscribed.');
  });
});

/** Sends `count` requests from one address and returns the status of the last. */
async function lastStatus(count: number, send: () => request.Test): Promise<number> {
  let status = 0;
  for (let i = 0; i < count; i += 1) status = (await send()).status;
  return status;
}

describe('public routes are rate limited per IP', () => {
  test('GET /storm/:code answers 429 past the limit', async () => {
    const send = () => request(t.app).get('/storm/zzzzzzzz').set('Host', A_HOST);
    expect(await lastStatus(PUBLIC_PAGE_RATE_LIMIT_PER_MIN, send)).toBe(404);
    const res = await send();
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: MESSAGES.tooFast });
  });

  test('the policy pages answer 429 past the limit', async () => {
    const send = () => request(t.app).get('/policies/nope-co/privacy');
    await lastStatus(PUBLIC_PAGE_RATE_LIMIT_PER_MIN, send);
    expect((await send()).status).toBe(429);
  });

  test('GET and POST /u/:token share the limit and answer 429', async () => {
    const send = () => request(t.app).get('/u/not-a-token');
    expect(await lastStatus(PUBLIC_PAGE_RATE_LIMIT_PER_MIN, send)).toBe(404);
    expect((await send()).status).toBe(429);
    const post = await request(t.app).post(`/u/${token()}`).set('Content-Type', 'application/x-www-form-urlencoded').send('');
    expect(post.status).toBe(429);
  });

  test('/hooks/postmark answers 429 past its limit', async () => {
    const send = () => request(t.app).post('/hooks/postmark').send({});
    await lastStatus(POSTMARK_HOOK_RATE_LIMIT_PER_MIN, send);
    expect((await send()).status).toBe(429);
  });

  test('ordinary page loads on the app host do not use the policy budget', async () => {
    for (let i = 0; i < PUBLIC_PAGE_RATE_LIMIT_PER_MIN + 5; i += 1) await request(t.app).get('/some-web-route');
    const res = await request(t.app).get('/policies/nope-co/privacy');
    expect(res.status).not.toBe(429);
  });
});

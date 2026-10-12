import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';
import { unsubscribeKey } from '../src/public/unsubscribe-key.ts';
import { signUnsubscribeToken } from '../src/public/unsubscribe-token.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * Email unsubscribe links (public/unsubscribe.ts): GET shows the page and records nothing; POST
 * records one opt-out row per (company, address), with the source the request names.
 */

const EMAIL = 'pat@example.com';
const NOT_FOUND_TEXT = 'This unsubscribe link is not valid.';
const DONE_TEXT = 'You are unsubscribed from Acme Roofing';
const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

afterEach(async () => {
  await t.close();
});

/** The valid token for a company and address, signed with the app's own secret. */
function tokenFor(companyId: string, email = EMAIL): string {
  return signUnsubscribeToken(unsubscribeKey(t.deps.config), { companyId, email });
}

const A = () => t.seed.a.companyId;
const B = () => t.seed.b.companyId;

/** Opt-out rows for a company, read as the owner so row-level security does not hide them. */
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

/** The page's own form post: no List-Unsubscribe field. */
const formPost = (token: string) =>
  request(t.app).post(`/u/${token}`).set('Content-Type', 'application/x-www-form-urlencoded').send('');

/** A mail provider's one-click post. No Origin header, as a provider sends it. */
const oneClickPost = (token: string) =>
  request(t.app).post(`/u/${token}`).set('Content-Type', 'application/x-www-form-urlencoded').send(ONE_CLICK_BODY);

describe('forged or unknown tokens', () => {
  test('a token whose signature does not match answers 404 on GET and POST and records nothing', async () => {
    const good = tokenFor(A());
    const [payload] = good.split('.');
    const forged = `${payload}.${'A'.repeat(43)}`;

    const get = await request(t.app).get(`/u/${forged}`);
    expect(get.status).toBe(404);
    expect(get.headers['content-type']).toMatch(/text\/html/);
    expect(get.text).toContain(NOT_FOUND_TEXT);

    const post = await formPost(forged);
    expect(post.status).toBe(404);
    expect(post.text).toContain(NOT_FOUND_TEXT);

    expect(await rowsFor(A())).toEqual([]);
  });

  test('a token signed with a different secret answers 404 on GET and POST and records nothing', async () => {
    const other = signUnsubscribeToken('a-different-secret-that-is-not-ours-0123', {
      companyId: A(),
      email: EMAIL,
    });

    expect((await request(t.app).get(`/u/${other}`)).status).toBe(404);
    expect((await formPost(other)).status).toBe(404);
    expect((await oneClickPost(other)).status).toBe(404);

    expect(await rowsFor(A())).toEqual([]);
  });

  test('a token for a company that does not exist answers 404 on GET and POST and records nothing', async () => {
    const unknown = tokenFor(randomUUID());

    expect((await request(t.app).get(`/u/${unknown}`)).status).toBe(404);
    expect((await formPost(unknown)).status).toBe(404);
    expect((await oneClickPost(unknown)).status).toBe(404);

    expect(await rowsFor(A())).toEqual([]);
  });
});

describe('the confirmation page', () => {
  test('GET shows the company name and a form to this token, and records nothing', async () => {
    const token = tokenFor(A());
    const res = await request(t.app).get(`/u/${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Acme Roofing');
    expect(res.text).toContain(`<form method="post" action="/u/${token}">`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(await rowsFor(A())).toEqual([]);
  });
});

describe('recording an opt-out', () => {
  test('the form post records one link row and shows the company name', async () => {
    const res = await formPost(tokenFor(A()));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain(DONE_TEXT);
    expect(await rowsFor(A())).toEqual([{ email: EMAIL, source: 'link' }]);
  });

  test('a one-click post records one one_click row and answers plain text', async () => {
    const fresh = 'fresh@example.com';
    const res = await oneClickPost(tokenFor(A(), fresh));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toBe('Unsubscribed.');
    expect(await rowsFor(A())).toEqual([{ email: fresh, source: 'one_click' }]);
  });

  test('posting twice leaves exactly one row, with the source of the first post', async () => {
    const token = tokenFor(A());

    expect((await formPost(token)).status).toBe(200);
    const again = await formPost(token);
    expect(again.status).toBe(200);
    expect(again.text).toContain(DONE_TEXT);

    expect(await rowsFor(A())).toEqual([{ email: EMAIL, source: 'link' }]);
  });

  test('a repeat one-click post also leaves exactly one row', async () => {
    const token = tokenFor(A());

    expect((await oneClickPost(token)).status).toBe(200);
    expect((await oneClickPost(token)).status).toBe(200);

    expect(await rowsFor(A())).toEqual([{ email: EMAIL, source: 'one_click' }]);
  });

  test('a token for company A never writes a row for company B', async () => {
    await formPost(tokenFor(A()));

    expect(await rowsFor(A())).toHaveLength(1);
    expect(await rowsFor(B())).toEqual([]);
  });
});

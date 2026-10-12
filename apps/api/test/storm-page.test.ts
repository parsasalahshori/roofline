import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, inject, test } from 'vitest';
import { insertOmahaStorm } from '@roofline/db/testing';
import { escapeHtml } from '../src/public/policy-text.ts';
import { STORM_FORM_ERRORS } from '../src/storm/landing.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const APP_HOST = 'app.roofline.test';
const A_HOST = 'acme-roofing.roofline.test';
const B_HOST = 'bolt-roofing.roofline.test';
const NOT_FOUND_TEXT = "We couldn't find that page.";
const CODE_A = 'abcd2345';
const CODE_B = 'bcde3456';
const CODE_OLD = 'cdef4567';
const WEB_MARKER = 'WEB-APP-MARKER-S1T20';

let t: TestApp;
let webDist: string;

beforeEach(async () => {
  t = await makeTestApp();
});

afterEach(async () => {
  await t.close();
});

afterAll(() => {
  if (webDist) fs.rmSync(webDist, { recursive: true, force: true });
});

/** Inserts a storm and a storm page for a company, as the owner role (which bypasses row-level security). */
async function makePage(companyId: string, code: string, activeUntil: Date): Promise<void> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    const q = async (text: string, values?: unknown[]) => (await client.query(text, values)).rows;
    const stormId = await insertOmahaStorm(q, '2026-10-10');
    const [cs] = await q(
      'insert into company_storms (company_id, storm_id, max_in) values ($1, $2, $3) returning id',
      [companyId, stormId, 1.5],
    );
    await q(
      'insert into storm_pages (company_id, company_storm_id, code, active_until) values ($1, $2, $3, $4)',
      [companyId, cs!.id, code, activeUntil],
    );
  } finally {
    await client.end();
  }
}

/** A page for company A, active for another 30 days. */
async function activePageForA(): Promise<void> {
  await makePage(t.seed.a.companyId, CODE_A, new Date(t.clock.now().getTime() + 30 * 86_400_000));
}

describe('storm landing page on the company host', () => {
  test('GET /storm/<code> shows only that company, noindex, uncached', async () => {
    await activePageForA();
    const res = await request(t.app).get(`/storm/${CODE_A}`).set('Host', A_HOST);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.text).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(res.text).toContain(t.seed.a.name);
    expect(res.text).toContain('Radar-estimated hail was reported near your area recently.');
    expect(res.text).toContain(`action="/api/public/storm-requests/${CODE_A}"`);
    expect(res.text).not.toContain(t.seed.b.name);
  });

  test('the code is matched in any letter case', async () => {
    await activePageForA();
    const res = await request(t.app).get(`/storm/${CODE_A.toUpperCase()}`).set('Host', A_HOST);
    expect(res.status).toBe(200);
    expect(res.text).toContain(t.seed.a.name);
  });

  test('GET /storm/<code>/thanks shows the thank-you state with no form', async () => {
    await activePageForA();
    const res = await request(t.app).get(`/storm/${CODE_A}/thanks`).set('Host', A_HOST);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<form');
    expect(res.text).toContain(`${t.seed.a.name} will call you`);
  });

  test("each company's page is served on its own host", async () => {
    await makePage(t.seed.b.companyId, CODE_B, new Date(t.clock.now().getTime() + 30 * 86_400_000));
    const res = await request(t.app).get(`/storm/${CODE_B}`).set('Host', B_HOST);

    expect(res.status).toBe(200);
    expect(res.text).toContain(t.seed.b.name);
    expect(res.text).not.toContain(t.seed.a.name);
  });

  test("a company's page requested on another company's host is a 404 that names nobody", async () => {
    await makePage(t.seed.b.companyId, CODE_B, new Date(t.clock.now().getTime() + 30 * 86_400_000));
    const res = await request(t.app).get(`/storm/${CODE_B}`).set('Host', A_HOST);

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain(NOT_FOUND_TEXT);
    expect(res.text).not.toContain(t.seed.b.name);
  });

  test('an inactive code (active_until in the past) is a 404', async () => {
    await makePage(t.seed.a.companyId, CODE_OLD, new Date(t.clock.now().getTime() - 86_400_000));
    const res = await request(t.app).get(`/storm/${CODE_OLD}`).set('Host', A_HOST);

    expect(res.status).toBe(404);
    expect(res.text).toContain(NOT_FOUND_TEXT);
    expect(res.text).not.toContain(t.seed.a.name);
  });

  test('an unknown code is a 404', async () => {
    const res = await request(t.app).get('/storm/zzzzzzzz').set('Host', A_HOST);
    expect(res.status).toBe(404);
    expect(res.text).toContain(NOT_FOUND_TEXT);
  });

  test('a malformed code is a 404 without a lookup', async () => {
    for (const code of ['abc', 'abcd23456', 'ABCD0189']) {
      const res = await request(t.app).get(`/storm/${code}`).set('Host', A_HOST);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain(NOT_FOUND_TEXT);
    }
  });

  test('a POST on the company host is not served by the page', async () => {
    await activePageForA();
    const res = await request(t.app).post(`/storm/${CODE_A}`).set('Host', A_HOST).send({});

    expect(res.status).not.toBe(200);
    expect(res.headers['x-robots-tag']).toBeUndefined();
    expect(res.text ?? '').not.toContain(t.seed.a.name);
  });

  test('GET /storm/<code>?error=phone shows the phone sentence as an alert', async () => {
    await activePageForA();
    const res = await request(t.app).get(`/storm/${CODE_A}?error=phone`).set('Host', A_HOST);

    expect(res.status).toBe(200);
    expect(res.text).toContain(escapeHtml(STORM_FORM_ERRORS.phone));
    expect(res.text).toContain('role="alert"');
  });

  test('GET /storm/<code>?error=<unknown key> shows no alert', async () => {
    await activePageForA();
    const res = await request(t.app).get(`/storm/${CODE_A}?error=bogus`).set('Host', A_HOST);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('role="alert"');
  });
});

describe('storm landing page codes', () => {
  test.each(['abc12345', 'abcd234', 'abcd23456', 'abcd-345'])('a malformed code %s is the generic 404 page', async (code) => {
    const res = await request(t.app).get(`/storm/${code}`).set('Host', A_HOST);

    expect(res.status).toBe(404);
    expect(res.text).toContain(NOT_FOUND_TEXT);
  });
});

describe('the app host still serves the web app under /storm', () => {
  beforeEach(() => {
    if (!webDist) {
      webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'roofline-storm-web-'));
      fs.writeFileSync(path.join(webDist, 'index.html'), `<!doctype html><html><body>${WEB_MARKER}</body></html>\n`);
    }
  });

  test('GET /storm/<uuid> on APP_ORIGIN host reaches the web app, not the landing 404', async () => {
    const { app } = await makeTestApp({ WEB_DIST_DIR: webDist });
    const res = await request(app).get(`/storm/${randomUUID()}`).set('Host', APP_HOST);

    expect(res.status).toBe(200);
    expect(res.text).toContain(WEB_MARKER);
    expect(res.text).not.toContain(NOT_FOUND_TEXT);
  });

  test('GET /storm/routes and /storm/plans/<uuid> on the app host reach the web app', async () => {
    const { app } = await makeTestApp({ WEB_DIST_DIR: webDist });

    const routes = await request(app).get('/storm/routes').set('Host', APP_HOST);
    expect(routes.status).toBe(200);
    expect(routes.text).toContain(WEB_MARKER);

    const plan = await request(app).get(`/storm/plans/${randomUUID()}`).set('Host', APP_HOST);
    expect(plan.status).toBe(200);
    expect(plan.text).toContain(WEB_MARKER);
  });
});

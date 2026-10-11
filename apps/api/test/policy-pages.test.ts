import pg from 'pg';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';
import { policyUrls } from '../src/public/policy-urls.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const COMPANY_HOST = 'acme-roofing.roofline.test';
const APP_HOST = 'app.roofline.test';
const NOT_FOUND_TEXT = "We couldn't find that page.";

const PRIVACY_LINES = [
  'No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.',
  'Text messaging originator opt-in data and consent will not be shared with any third parties.',
];
const TERMS_LINES = [
  'Message frequency varies.',
  'Message and data rates may apply.',
  'Reply STOP to opt out',
  'Reply HELP for help',
  'Carriers are not liable for delayed or undelivered messages.',
];

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

afterEach(async () => {
  await t.close();
});

/** Renames a company as the owner role, which bypasses row-level security. */
async function renameCompany(slug: string, name: string): Promise<void> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    await client.query('update companies set name = $1 where slug = $2', [name, slug]);
  } finally {
    await client.end();
  }
}

describe('hosted policy pages', () => {
  test('privacy on the company host', async () => {
    const res = await request(t.app).get('/privacy').set('Host', COMPANY_HOST);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    for (const line of PRIVACY_LINES) expect(res.text).toContain(line);
    expect(res.text).toContain('Acme Roofing');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.text).toContain('<meta name="policy-version" content="draft-2026-10">');
  });

  test('terms carry the texting program terms', async () => {
    const res = await request(t.app).get('/terms').set('Host', COMPANY_HOST);

    expect(res.status).toBe(200);
    for (const line of TERMS_LINES) expect(res.text).toContain(line);
  });

  test('the path form works on any host', async () => {
    const terms = await request(t.app).get('/policies/acme-roofing/terms').set('Host', APP_HOST);
    expect(terms.status).toBe(200);

    const privacy = await request(t.app).get('/policies/acme-roofing/privacy').set('Host', APP_HOST);
    expect(privacy.status).toBe(200);
  });

  test('an unknown slug is a plain 404 page', async () => {
    const companyHost = await request(t.app).get('/privacy').set('Host', 'nobody.roofline.test');
    expect(companyHost.status).toBe(404);
    expect(companyHost.headers['content-type']).toMatch(/text\/html/);
    expect(companyHost.text).toContain(NOT_FOUND_TEXT);

    const pathForm = await request(t.app).get('/policies/nobody/privacy').set('Host', APP_HOST);
    expect(pathForm.status).toBe(404);
    expect(pathForm.headers['content-type']).toMatch(/text\/html/);
    expect(pathForm.text).toContain(NOT_FOUND_TEXT);

    const otherPath = await request(t.app).get('/other').set('Host', COMPANY_HOST);
    expect(otherPath.status).toBe(404);
    expect(otherPath.headers['content-type']).toMatch(/text\/html/);
    expect(otherPath.text).toContain(NOT_FOUND_TEXT);
  });

  test('company details are escaped', async () => {
    await renameCompany('acme-roofing', 'Acme <script>alert(1)</script>');

    const res = await request(t.app).get('/privacy').set('Host', COMPANY_HOST);

    expect(res.status).toBe(200);
    expect(res.text).toContain('&lt;script&gt;');
    expect(res.text).not.toContain('<script>alert');
  });

  test('an uppercase host works and the app host passes through', async () => {
    const page = await request(t.app).get('/privacy').set('Host', 'ACME-ROOFING.Roofline.Test:443');
    expect(page.status).toBe(200);

    const health = await request(t.app).get('/health').set('Host', APP_HOST);
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true });
  });

  test('policyUrls', () => {
    const withDomain = policyUrls(
      { POLICY_PAGES_DOMAIN: 'roofline.test', PUBLIC_BASE_URL: 'https://app.roofline.test' },
      'acme-roofing',
    );
    expect(withDomain.privacy).toBe('https://acme-roofing.roofline.test/privacy');
    expect(withDomain.terms).toBe('https://acme-roofing.roofline.test/terms');

    const withoutDomain = policyUrls(
      { POLICY_PAGES_DOMAIN: undefined, PUBLIC_BASE_URL: 'https://app.roofline.test' },
      'acme-roofing',
    );
    expect(withoutDomain.privacy).toBe('https://app.roofline.test/policies/acme-roofing/privacy');
    expect(withoutDomain.terms).toMatch(/\/terms$/);
  });
});

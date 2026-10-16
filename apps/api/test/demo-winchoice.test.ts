import request from 'supertest';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';
import { MemoryObjectStore } from '../src/providers/fakes/object-store.ts';
import { DEMO_COMPANY_SLUG, DEMO_LOGIN, seedDemoWorld } from '../src/scripts/demo-world.ts';
import {
  DEMO_WINCHOICE_BRAND_COLOR,
  DEMO_WINCHOICE_LOGIN,
  DEMO_WINCHOICE_NAME,
  DEMO_WINCHOICE_QUOTE_SLUG,
  DEMO_WINCHOICE_SLUG,
  WINCHOICE_JOBS,
  seedWinChoiceWorld,
} from '../src/scripts/demo-winchoice.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from './helpers.ts';

let t: TestApp;
let owner: pg.Client;

beforeEach(async () => {
  t = await makeTestApp();
  owner = new pg.Client({ connectionString: inject('dbUrls').owner });
  await owner.connect();
});

afterEach(async () => {
  await owner.end();
});

describe('the WinChoice demo company', () => {
  test('is a second, separate company with its own owner login and red brand, and a second run changes nothing', async () => {
    const ownerUrl = inject('dbUrls').owner;
    const now = t.clock.now();
    const opts = { encryptionKey: TEST_ENCRYPTION_KEY, objectStore: new MemoryObjectStore() };
    // An older demo database has only Summit Ridge: WinChoice is added next to it.
    const summit = await seedDemoWorld(t.deps.pools, ownerUrl, now, opts);
    const first = await seedWinChoiceWorld(t.deps.pools, ownerUrl, now, opts);
    expect(first.created).toBe(true);
    expect(first.companyId).not.toBe(summit.companyId);

    const company = (
      await owner.query(
        `select c.name, c.slug, c.timezone, c.address_city, c.address_state, c.logo_url, s.quote_enabled, s.quote_slug, s.quote_products, s.quote_accent_color
           from companies c join company_settings s on s.company_id = c.id where c.id = $1`,
        [first.companyId],
      )
    ).rows[0];
    expect(company).toMatchObject({
      name: DEMO_WINCHOICE_NAME,
      slug: DEMO_WINCHOICE_SLUG,
      timezone: 'America/Chicago',
      address_city: 'Little Rock',
      address_state: 'AR',
      logo_url: null,
      quote_enabled: true,
      quote_slug: DEMO_WINCHOICE_QUOTE_SLUG,
      quote_products: ['windows', 'roof'],
      quote_accent_color: DEMO_WINCHOICE_BRAND_COLOR,
    });
    // Summit Ridge keeps its own (default) brand, and now shows its city under the name.
    const summitRow = (await owner.query(`select address_city, quote_accent_color from companies c join company_settings s on s.company_id = c.id where c.id = $1`, [summit.companyId])).rows[0];
    expect(summitRow).toMatchObject({ address_city: 'Omaha', quote_accent_color: null });

    const c = first.counts;
    expect(c.members).toBe(4);
    expect(c.customers).toBe(WINCHOICE_JOBS.length);
    expect(c.jobs).toBe(WINCHOICE_JOBS.length);
    expect([c['jobs.lead'], c['jobs.inspection'], c['jobs.proposal'], c['jobs.won'], c['jobs.installed'], c['jobs.lost']]).toEqual([3, 2, 3, 2, 1, 1]);
    expect(c.appointments).toBe(3);
    expect(c.calls).toBe(2);
    expect(c.conversations).toBe(4);
    expect(c['agentTasks.draft']).toBe(1);
    expect(c.minutesSaved).toBeGreaterThan(0);

    // Every address is in Arkansas.
    const states = (await owner.query(`select distinct state from properties where company_id = $1`, [first.companyId])).rows;
    expect(states).toEqual([{ state: 'AR' }]);

    // Two owners, two logins: each sees only their own company, and only WinChoice has a brand colour.
    const winchoice = request.agent(t.app);
    expect((await winchoice.post('/api/auth/login').send(DEMO_WINCHOICE_LOGIN)).status).toBe(200);
    expect((await winchoice.get('/api/auth/me')).body.company).toMatchObject({ name: DEMO_WINCHOICE_NAME, slug: DEMO_WINCHOICE_SLUG });
    expect((await winchoice.get('/api/company')).body).toMatchObject({ addressCity: 'Little Rock', brandColor: DEMO_WINCHOICE_BRAND_COLOR });
    const summitOwner = request.agent(t.app);
    expect((await summitOwner.post('/api/auth/login').send(DEMO_LOGIN)).status).toBe(200);
    expect((await summitOwner.get('/api/auth/me')).body.company).toMatchObject({ slug: DEMO_COMPANY_SLUG });
    expect((await summitOwner.get('/api/company')).body).toMatchObject({ brandColor: null });
    const memberships = (await owner.query(`select count(*)::int as n from memberships m join users u on u.id = m.user_id where u.email = $1`, [DEMO_WINCHOICE_LOGIN.email])).rows[0];
    expect(memberships.n).toBe(1);

    // The instant quote page is on, windows first.
    const page = await request(t.app).get(`/api/public/quote/${DEMO_WINCHOICE_QUOTE_SLUG}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ companyName: DEMO_WINCHOICE_NAME, accentColor: DEMO_WINCHOICE_BRAND_COLOR, logoUrl: null });
    expect(page.body.products).toEqual(['windows', 'roof']);

    const second = await seedWinChoiceWorld(t.deps.pools, ownerUrl, now, opts);
    expect(second).toEqual({ created: false, companyId: first.companyId, counts: first.counts });
  });
});

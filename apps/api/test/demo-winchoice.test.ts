import request from 'supertest';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';
import { DEMO_COMPANY_SLUG, DEMO_LOGIN, seedDemoWorld } from '../src/scripts/demo-world.ts';
import {
  DEMO_WINCHOICE_BRAND_COLOR,
  DEMO_WINCHOICE_LOGO_URL,
  DEMO_WINCHOICE_LOGIN,
  DEMO_WINCHOICE_NAME,
  DEMO_WINCHOICE_QUOTE_SLUG,
  DEMO_WINCHOICE_SLUG,
  WINCHOICE_JOBS,
  seedWinChoiceWorld,
} from '../src/scripts/demo-winchoice.ts';
import { WINCHOICE_BACKOFFICE_ORDERS } from '../src/scripts/demo-winchoice-backoffice.ts';
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
    const opts = { encryptionKey: TEST_ENCRYPTION_KEY, objectStore: t.deps.objectStore };
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
      logo_url: DEMO_WINCHOICE_LOGO_URL,
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
    // A customer for each job, and two more: the callers Front Desk booked, who are new and have no job yet. The back office adds
    // seven more won jobs (the orders that are not on the twelve).
    const newOrderJobs = WINCHOICE_BACKOFFICE_ORDERS.filter((o) => o.newJob !== undefined);
    const newInstalled = newOrderJobs.filter((o) => o.stage === 'installed' || o.stage === 'complete').length;
    expect(newOrderJobs).toHaveLength(7);
    expect(c.customers).toBe(WINCHOICE_JOBS.length + 2 + newOrderJobs.length);
    expect(c.jobs).toBe(WINCHOICE_JOBS.length + newOrderJobs.length);
    expect([c['jobs.lead'], c['jobs.inspection'], c['jobs.proposal'], c['jobs.won'], c['jobs.installed'], c['jobs.lost']]).toEqual([3, 2, 3, 2 + newOrderJobs.length - newInstalled, 1 + newInstalled, 1]);
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
    expect(page.body).toMatchObject({ companyName: DEMO_WINCHOICE_NAME, accentColor: DEMO_WINCHOICE_BRAND_COLOR, logoUrl: DEMO_WINCHOICE_LOGO_URL });
    expect(page.body.products).toEqual(['windows', 'roof']);

    // Measure windows: 305 Ridgeway Dr has seven windows (four measured on site, three counted from the walls) and a draft order.
    expect(c.windowMeasurements).toBe(1);
    expect(c.windowOrders).toBe(1);
    const measurementId = String((await owner.query(`select id from window_measurements where company_id = $1`, [first.companyId])).rows[0]?.id);
    const view = (await winchoice.get(`/api/window-measurements/${measurementId}`)).body;
    expect(view.address).toBe('305 Ridgeway Dr, Little Rock, AR 72205');
    expect(view.walls).toMatchObject({ perimeterFt: expect.closeTo(128, 0), frontWallFt: expect.closeTo(31, 0) });
    // Six readings of four windows: the living-room slider three times (LiDAR), the kitchen, bath and hall once each (measuring sheet).
    expect(view.photoWindows.map((w: { id: string; widthIn: number; heightIn: number }) => [w.id, w.widthIn, w.heightIn])).toEqual([
      ['w1-r1', 71.25, 59.38],
      ['w1-r2', 71.38, 59.5],
      ['w1-r3', 71.63, 59.75],
      ['w2-r1', 35.62, 47.88],
      ['w3-r1', 23.5, 35.75],
      ['w7-r1', 29.87, 47.75],
    ]);
    const order = (await winchoice.get(`/api/window-measurements/${measurementId}/order`)).body;
    expect(order.status).toBe('draft');
    expect(order.checked.map((l: { id: string; status: string }) => [l.id, l.status])).toEqual([
      ['w1', 'check'],
      ['w2', 'ready'],
      ['w3', 'ready'],
      ['w7', 'ready'],
    ]);
    expect(order.checked[1].order).toEqual({ widthIn: 35.125, heightIn: 47.375 });
    // The photos are stored, so the order sheet's thumbnails load.
    const photo = await winchoice.get(`/api/window-measurements/${measurementId}/uploads/${order.lines[1].uploadId}`);
    expect(photo.status).toBe(200);

    // The back office is on for WinChoice (and off for Summit Ridge), with quotes of drawn units and one order in each stage.
    expect((await winchoice.get('/api/auth/me')).body.company.backofficeEnabled).toBe(true);
    expect((await summitOwner.get('/api/auth/me')).body.company.backofficeEnabled).toBe(false);
    expect((await summitOwner.get('/api/backoffice/orders')).status).toBe(404);
    expect(c.backofficeQuotes).toBe(3 + WINCHOICE_BACKOFFICE_ORDERS.length);
    expect(c.backofficeOrders).toBe(10);
    const board = (await winchoice.get('/api/backoffice/orders')).body as { stage: string; daysInStage: number; events: { stage: string }[]; units: number; totalCents: number }[];
    expect(new Set(board.map((o) => o.stage)).size).toBe(10);
    expect(board.every((o) => o.totalCents > 0 && o.units > 0 && o.events.length >= 1)).toBe(true);
    const quotes = (await winchoice.get('/api/backoffice/quotes')).body as { status: string; units: number }[];
    expect(quotes.filter((x) => x.status === 'draft')).toHaveLength(2);
    expect(quotes.filter((x) => x.status === 'presented')).toHaveLength(1);
    expect(quotes.every((x) => x.units > 0)).toBe(true);
    // The first quote starts from the measured Ridgeway windows.
    const ridgeway = (await winchoice.get('/api/backoffice/quotes?jobId=' + (await owner.query(`select id from jobs where company_id = $1 and property_id in (select id from properties where address_line = '305 Ridgeway Dr')`, [first.companyId])).rows[0].id)).body as { id: string }[];
    const fromMeasured = (await winchoice.get(`/api/backoffice/quotes/${ridgeway[0]!.id}`)).body;
    expect(fromMeasured.designs.length).toBeGreaterThan(0);
    expect(fromMeasured.designs.every((d: { sizeSource: { kind: string } }) => d.sizeSource.kind === 'measured')).toBe(true);

    const second = await seedWinChoiceWorld(t.deps.pools, ownerUrl, now, opts);
    expect(second).toEqual({ created: false, companyId: first.companyId, counts: first.counts });
  });
});

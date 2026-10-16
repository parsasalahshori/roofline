import pg from 'pg';
import { beforeEach, describe, expect, inject, it } from 'vitest';
import { Actors, addressFor, mustCreate, NO_UUID } from './crm-helpers.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';
import type { LngLat, Ring, WindowMeasurementView, WindowOrderView } from '@roofline/shared';
import { seedFootprintFixture } from '../src/scripts/footprint-fixture.ts';
import { windowPhoto } from './window-photo-fixture.ts';
import { ORDER_CSV_HEADERS } from '../src/estimator/window-order-sheet.ts';

/*
 * Window factory orders through the API, on a real Postgres. A measured house gets on-site photo windows (the synthetic
 * 36 x 60 in window with a letter sheet on its glass); the order is drafted from them, edited, marked ready and exported.
 */

const NOW = new Date('2026-10-15T15:00:00.000Z');
const HOUSE: Ring = [
  [-96.0, 41.25],
  [-95.9997, 41.25],
  [-95.9997, 41.2502],
  [-96.0, 41.2502],
  [-96.0, 41.25],
];
const INSIDE: LngLat = [-95.99985, 41.2501];

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
});

async function ownerSql(text: string, params: unknown[] = []): Promise<void> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    await client.query(text, params);
  } finally {
    await client.end();
  }
}

/** A house measured by `agent` (on a property it can see), with `n` photo windows on one on-site photo. */
async function houseWithPhotoWindows(agent: SuperAgent, n: number, opts: { customerId?: string; address?: number } = {}): Promise<WindowMeasurementView> {
  await seedFootprintFixture(t.deps.pools, [{ sourceRef: `house-${opts.address ?? 1}`, ring: HOUSE }]);
  const property = await mustCreate(agent, '/api/properties', { ...addressFor(opts.address ?? 1), ...(opts.customerId !== undefined ? { customerId: opts.customerId } : {}) });
  await ownerSql(`update properties set geom = ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326) where id = $3`, [INSIDE[0], INSIDE[1], property.id]);
  const created = await agent.post('/api/window-measurements').send({ propertyId: property.id });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const view = created.body as WindowMeasurementView;
  if (n === 0) return view;
  const photo = windowPhoto();
  const up = await agent.post(`/api/window-measurements/${view.id}/uploads`).attach('photo', Buffer.from(photo.bytes), 'w.jpg');
  expect(up.status).toBe(201);
  const photoWindows = Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    uploadId: up.body.id,
    label: ['Kitchen', 'Den', 'Bath', 'Bedroom'][i] ?? `Room ${i + 1}`,
    corners: photo.window,
    scale: { kind: 'reference', reference: 'letter', corners: photo.paper },
  }));
  const patched = await agent.patch(`/api/window-measurements/${view.id}`).send({ photoWindows });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  return patched.body as WindowMeasurementView;
}

async function draft(agent: SuperAgent, measurementId: string): Promise<WindowOrderView> {
  const res = await agent.post(`/api/window-measurements/${measurementId}/order`);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as WindowOrderView;
}

const ALL_DOUBLE_HUNG = (v: WindowOrderView) => v.lines.map((l) => ({ id: l.id, style: 'double-hung' }));

describe('POST /api/window-measurements/:id/order', () => {
  it('drafts one line per photo window with the order size worked out; Street View and estimated windows are not lines', async () => {
    const owner = await who.as('owner');
    const m = await houseWithPhotoWindows(owner, 2);
    const order = await draft(owner, m.id);
    expect(order).toMatchObject({ windowMeasurementId: m.id, status: 'draft', poNumber: '', canMarkReady: false, mayMarkReady: true });
    expect(order.lines.map((l) => [l.id, l.location, l.style, l.photoWindowIds])).toEqual([
      ['p1', 'Kitchen', null, ['p1']],
      ['p2', 'Den', null, ['p2']],
    ]);
    // The photo window measures about 36 x 60 in; the order is the measurement less 1/4 in, floored to 1/8 in.
    const w = m.photoWindows![0]!;
    const c = order.checked[0]!;
    expect(c.order!.widthIn).toBe(Math.floor((w.widthIn - 0.25) * 8 + 1e-9) / 8);
    expect(c.order!.heightIn).toBe(Math.floor((w.heightIn - 0.25) * 8 + 1e-9) / 8);
    expect(c.status).toBe('error');
    expect(c.reasons.map((r) => r.message)).toContain('Pick a style.');
    expect(order.settings).toMatchObject({ widthDeductionIn: 0.25, heightDeductionIn: 0.25, roundingIn: 0.125, uncertaintyFactor: 1 });
    // The estimate (walls) is never on the order: only the 2 photographed windows.
    expect(m.estimated!.covers).toBe('all-sides');
    expect(order.lines).toHaveLength(2);
  });

  it('a measurement with no photo windows cannot be ordered (422, saying why)', async () => {
    const owner = await who.as('owner');
    const m = await houseWithPhotoWindows(owner, 0);
    const res = await owner.post(`/api/window-measurements/${m.id}/order`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Only windows measured from on-site photos can be ordered. Photograph and measure a window on site first.');
    expect((await owner.get(`/api/window-measurements/${m.id}/order`)).status).toBe(404);
  });

  it('posting again refreshes the draft from the photos and keeps the options; excluded photos drop out', async () => {
    const owner = await who.as('owner');
    const m = await houseWithPhotoWindows(owner, 2);
    const order = await draft(owner, m.id);
    await owner.patch(`/api/window-orders/${order.id}`).send({ lines: [{ id: 'p1', style: 'slider-2', location: 'Kitchen sink' }] });
    await owner.patch(`/api/window-measurements/${m.id}`).send({ excludedWindowIds: ['p2'] });
    const again = await owner.post(`/api/window-measurements/${m.id}/order`);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(order.id);
    expect(again.body.lines.map((l: { id: string; style: string; location: string }) => [l.id, l.style, l.location])).toEqual([['p1', 'slider-2', 'Kitchen sink']]);
    expect((await owner.get(`/api/window-measurements/${m.id}/order`)).body.id).toBe(order.id);
  });
});

describe('PATCH /api/window-orders/:id', () => {
  it('saves options per line and the PO number, and validates them', async () => {
    const owner = await who.as('owner');
    const m = await houseWithPhotoWindows(owner, 2);
    const order = await draft(owner, m.id);
    const url = `/api/window-orders/${order.id}`;
    const res = await owner.patch(url).send({
      poNumber: 'WC-1001',
      lines: [
        { id: 'p1', style: 'double-hung', frameExterior: 'bronze', grid: { type: 'colonial', top: '3x2', bottom: '3x2' }, screen: 'half' },
        { id: 'p2', style: 'picture', obscure: true, glass: 'triple-lowe-argon', quantity: 2 },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const v = res.body as WindowOrderView;
    expect(v.poNumber).toBe('WC-1001');
    expect(v.lines[0]).toMatchObject({ style: 'double-hung', frameExterior: 'bronze', frameInterior: 'white', screen: 'half', grid: { type: 'colonial', top: '3x2', bottom: '3x2' } });
    expect(v.checked.map((c) => c.status)).toEqual(['ready', 'ready']);
    expect(v.totals.windows).toBe(3);
    expect(v.canMarkReady).toBe(true);

    const bad = async (body: unknown) => (await owner.patch(url).send(body)).status;
    expect(await bad({ lines: [{ id: 'p1', style: 'bay' }] })).toBe(400);
    expect(await bad({ lines: [{ id: 'p1', quantity: 0 }] })).toBe(400);
    expect(await bad({ lines: [{ id: 'p1', grid: { type: 'colonial', top: '3 by 2', bottom: '' } }] })).toBe(400);
    expect(await bad({ lines: [{ id: 'p1', measured: [] }] })).toBe(400); // sizes cannot be typed
    expect(await bad({ lines: [{ id: 'p1', lockedSize: { widthIn: 1, heightIn: 1 } }] })).toBe(400);
    expect(await bad({ lines: [{ id: 'nope', style: 'picture' }] })).toBe(400);
    expect(await bad({ lines: [{ id: 'p1', safety: { besideDoor: 'yes', wetArea: null, sillHeightIn: null, walkway: null } }] })).toBe(400);
    expect(await bad({ poNumber: 'x'.repeat(41) })).toBe(400);
    expect(await bad({ other: 1 })).toBe(400);
    expect((await owner.patch(`/api/window-orders/${NO_UUID}`).send({ poNumber: 'A' })).status).toBe(404);
  });

  it('safety answers produce a tempered suggestion (a check) until tempered is ticked or the line is confirmed', async () => {
    const owner = await who.as('owner');
    const m = await houseWithPhotoWindows(owner, 1);
    const order = await draft(owner, m.id);
    const url = `/api/window-orders/${order.id}`;
    const v = (await owner.patch(url).send({ lines: [{ id: 'p1', style: 'double-hung', safety: { besideDoor: true, wetArea: false, sillHeightIn: 24, walkway: true } }] })).body as WindowOrderView;
    expect(v.checked[0]).toMatchObject({ status: 'check', orderable: false });
    expect(v.checked[0]!.suggestions.map((s) => s.code)).toEqual(['IRC R308.4.2']);
    expect(v.canMarkReady).toBe(false);
    const t2 = (await owner.patch(url).send({ lines: [{ id: 'p1', tempered: true }] })).body as WindowOrderView;
    expect(t2.checked[0]!.status).toBe('ready');
    expect(t2.lines[0]!.tempered).toBe(true);
  });
});

describe('ready, roles and the lock', () => {
  it('owner marks it ready: sizes locked, edits refused, CSV available; reopen unlocks', async () => {
    const owner = await who.as('owner');
    const m = await houseWithPhotoWindows(owner, 2);
    const order = await draft(owner, m.id);
    const url = `/api/window-orders/${order.id}`;
    expect((await owner.post(`${url}/ready`)).status).toBe(409); // no styles yet
    await owner.patch(url).send({ poNumber: 'WC-7', lines: ALL_DOUBLE_HUNG(order) });
    const ready = await owner.post(`${url}/ready`);
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    const v = ready.body as WindowOrderView;
    expect(v.status).toBe('ready');
    expect(v.readyAt).toBe(NOW.toISOString());
    expect(v.lines.every((l) => l.lockedSize !== null)).toBe(true);
    expect(v.lines[0]!.lockedSize).toEqual(v.checked[0]!.order);

    // A later change to the company's rule does not move a locked size.
    expect((await owner.put('/api/window-order-settings').send({ widthDeductionIn: 1 })).status).toBe(200);
    expect(((await owner.get(url)).body as WindowOrderView).checked[0]!.order).toEqual(v.lines[0]!.lockedSize);

    const locked = await owner.patch(url).send({ lines: [{ id: 'p1', quantity: 2 }] });
    expect(locked.status).toBe(409);
    expect(locked.body.error).toBe('This order is marked ready and its sizes are locked. Reopen it to change it.');
    expect((await owner.post(`${url}/ready`)).status).toBe(409);
    // Posting the measurement's order again returns it unchanged.
    expect((await owner.post(`/api/window-measurements/${m.id}/order`)).body.status).toBe('ready');

    const sent = await owner.post(`${url}/sent`);
    expect(sent.body).toMatchObject({ status: 'sent', sentAt: NOW.toISOString(), sentBy: who.user('owner').userId });

    const reopened = await owner.post(`${url}/reopen`);
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ status: 'draft', readyAt: null, sentAt: null });
    expect((reopened.body as WindowOrderView).lines.every((l) => l.lockedSize === null)).toBe(true);
    // Unlocked, the new 1 in deduction applies.
    expect((reopened.body as WindowOrderView).checked[0]!.order!.widthIn).toBeLessThan(v.lines[0]!.lockedSize!.widthIn);
  });

  it('office may mark ready; a rep may draft and edit but not mark ready', async () => {
    const rep = await who.as('rep');
    const customer = await mustCreate(rep, '/api/customers', { displayName: 'Rep Customer' });
    const m = await houseWithPhotoWindows(rep, 1, { customerId: customer.id });
    const order = await draft(rep, m.id);
    expect(order.mayMarkReady).toBe(false);
    const url = `/api/window-orders/${order.id}`;
    expect((await rep.patch(url).send({ lines: ALL_DOUBLE_HUNG(order) })).status).toBe(200);
    const refused = await rep.post(`${url}/ready`);
    expect(refused.status).toBe(403);
    expect((await rep.post(`${url}/sent`)).status).toBe(403);
    const office = await who.as('office');
    expect(((await office.get(url)).body as WindowOrderView).mayMarkReady).toBe(true);
    expect((await office.post(`${url}/ready`)).status).toBe(200);
    expect((await rep.post(`${url}/reopen`)).status).toBe(403);
  });

  it('only the owner changes the company settings', async () => {
    const office = await who.as('office');
    expect((await office.put('/api/window-order-settings').send({ widthDeductionIn: 0.5 })).status).toBe(403);
    const owner = await who.as('owner');
    const saved = await owner.put('/api/window-order-settings').send({ widthDeductionIn: 0.375, roundingIn: 0.0625, limits: { casement: { maxWidthIn: 40 } } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ widthDeductionIn: 0.375, heightDeductionIn: 0.25, roundingIn: 0.0625 });
    expect(saved.body.limits.casement).toMatchObject({ maxWidthIn: 40, minWidthIn: 14 });
    expect((await owner.put('/api/window-order-settings').send({ roundingIn: 0.2 })).status).toBe(400);
    expect((await owner.put('/api/window-order-settings').send({ limits: { casement: { minWidthIn: 50, maxWidthIn: 40 } } })).status).toBe(400);
    expect((await owner.put('/api/window-order-settings').send({})).body.widthDeductionIn).toBe(0.25);
  });
});

describe('the sheet', () => {
  it('CSV: one row per group with order sizes; refused for a draft', async () => {
    const owner = await who.as('owner');
    const m = await houseWithPhotoWindows(owner, 3);
    const order = await draft(owner, m.id);
    const url = `/api/window-orders/${order.id}`;
    expect((await owner.get(`${url}/sheet.csv`)).status).toBe(409);
    // p1 and p2 are the same window built the same way -> one line of 2; p3 is obscure -> its own line.
    await owner.patch(url).send({
      poNumber: 'WC-42',
      lines: [
        { id: 'p1', style: 'double-hung' },
        { id: 'p2', style: 'double-hung' },
        { id: 'p3', style: 'double-hung', obscure: true, notes: '=cmd' },
      ],
    });
    const v = (await owner.post(`${url}/ready`)).body as WindowOrderView;
    const res = await owner.get(`${url}/sheet.csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="window-order-WC-42.csv"');
    const rows = (res.text as string).trim().split('\r\n');
    expect(rows[0]).toBe(ORDER_CSV_HEADERS.join(','));
    expect(rows).toHaveLength(3);
    const { widthIn, heightIn } = v.checked[0]!.order!;
    expect(rows[1]!.startsWith(`WC-42,1,2,Kitchen; Den,Double-hung,${widthIn},${heightIn},`)).toBe(true);
    expect(rows[1]).toContain(',White,White,None,Dual pane Low-E + argon,No,No,Full,No,');
    expect(rows[2]).toContain(',Bath,Double-hung,');
    expect(rows[2]).toContain(',Yes,Full,No,'); // obscure
    expect(rows[2]!.endsWith(",'=cmd")).toBe(true); // formula-guarded
  });

  it('PDF: served for a draft and a ready order', async () => {
    const owner = await who.as('owner');
    const m = await houseWithPhotoWindows(owner, 1);
    const order = await draft(owner, m.id);
    const res = await owner.get(`/api/window-orders/${order.id}/sheet.pdf`).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('isolation', () => {
  it('another company, and a rep who cannot see the house, get 404 for everything', async () => {
    const owner = await who.as('owner');
    const m = await houseWithPhotoWindows(owner, 1);
    const order = await draft(owner, m.id);
    const other = await who.as('owner', 'b');
    const url = `/api/window-orders/${order.id}`;
    for (const agent of [other, await who.as('rep')]) {
      expect((await agent.get(url)).status).toBe(404);
      expect((await agent.patch(url).send({ poNumber: 'X' })).status).toBe(404);
      expect((await agent.get(`${url}/sheet.pdf`)).status).toBe(404);
      expect((await agent.post(`/api/window-measurements/${m.id}/order`)).status).toBe(404);
      expect((await agent.get(`/api/window-measurements/${m.id}/order`)).status).toBe(404);
    }
    expect((await other.post(`${url}/ready`)).status).toBe(404);
    expect((await other.get('/api/window-order-settings')).body.widthDeductionIn).toBe(0.25);
  });
});

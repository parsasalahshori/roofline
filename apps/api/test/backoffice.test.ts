import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  DEFAULT_PRODUCT_CATALOG,
  layoutForStyle,
  NO_SAFETY_ANSWERS,
  type BackofficeOrder,
  type BackofficeQuote,
  type LngLat,
  type ProductCatalog,
  type Ring,
  type WindowDesign,
  type WindowMeasurementView,
} from '@roofline/shared';
import { sql as dsql } from 'drizzle-orm';
import { Actors, addressFor, inCompany, mustCreate } from './crm-helpers.ts';
import { greyJpeg, sha256 } from './homeowner-fixture.ts';
import { makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';
import { seedFootprintFixture } from '../src/scripts/footprint-fixture.ts';
import { windowPhoto } from './window-photo-fixture.ts';

/*
 * The WinChoice back office through the API, on a real Postgres: the on/off gate, roles, tenant isolation, the catalog, quotes
 * priced by the server, accepting a quote into an order, stage moves that text and email the customer (only with consent), the
 * homeowner app's status, the house picture and the four PDFs.
 */

const NOW = new Date('2026-10-15T15:00:00.000Z'); // Thursday 10:00 in Chicago: inside sending hours
const BASE = '/api/backoffice';

let t: TestApp;
let who: Actors;
let db: pg.Pool;

beforeAll(() => {
  db = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await db.end();
});
const sql = async (text: string, values: unknown[] = []) => (await db.query(text, values)).rows;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(NOW);
  await setBackoffice(t.seed.a.companyId, true);
});

async function setBackoffice(companyId: string, on: boolean): Promise<void> {
  await sql(
    `insert into company_settings (company_id, backoffice_enabled) values ($1, $2) on conflict (company_id) do update set backoffice_enabled = excluded.backoffice_enabled`,
    [companyId, on],
  );
}

/** A job (and its customer and address) made through the API by `agent`; the customer can be texted and emailed. */
async function jobFor(agent: SuperAgent, o: { consent?: string; n?: number; assignTo?: string } = {}): Promise<{ jobId: string; customerId: string; propertyId: string }> {
  const customer = await mustCreate(agent, '/api/customers', { displayName: 'Dana Roe', firstName: 'Dana' });
  const property = await mustCreate(agent, '/api/properties', { ...addressFor(o.n ?? 1), customerId: customer.id });
  const job = await mustCreate(agent, '/api/jobs', { customerId: customer.id, propertyId: property.id, stage: 'proposal', valueCents: 100 });
  await sql(
    `update customers set phones = $2::jsonb, emails = $3::jsonb, sms_consent_status = $4 where id = $1`,
    [customer.id, JSON.stringify([{ e164: '+14025550111', label: 'mobile', primary: true }]), JSON.stringify(['dana@example.test']), o.consent ?? 'express'],
  );
  if (o.assignTo !== undefined) await sql(`update jobs set assigned_user_id = $2 where id = $1`, [job.id, o.assignTo]);
  return { jobId: job.id, customerId: customer.id, propertyId: property.id };
}

const unit = (over: Partial<WindowDesign> = {}): WindowDesign => ({
  id: 'u1',
  label: 'Kitchen',
  productId: 'wc-double-hung',
  quantity: 2,
  shape: 'rect',
  widthIn: 35.5,
  heightIn: 59.5,
  layout: layoutForStyle('double-hung', 35.5, { top: '3x2', bottom: '3x2' }),
  options: { 'exterior-color': 'ext-bronze' },
  gridType: 'colonial',
  screen: 'half',
  safety: { ...NO_SAFETY_ANSWERS },
  sizeSource: { kind: 'typed' },
  notes: '',
  ...over,
});

async function newQuote(agent: SuperAgent, jobId: string, extra: Record<string, unknown> = {}): Promise<BackofficeQuote> {
  const res = await agent.post(`${BASE}/quotes`).send({ jobId, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as BackofficeQuote;
}

/** Saves the quote with these units, the chosen tier and discount, and answers the server's view. */
async function save(agent: SuperAgent, q: BackofficeQuote, over: Record<string, unknown> = {}): Promise<request.Response> {
  return agent.put(`${BASE}/quotes/${q.id}`).send({ tier: q.tier, designs: q.designs, accessories: q.accessories, discountPercent: q.discountPercent, ...over });
}

async function acceptedOrder(agent: SuperAgent, opts: { consent?: string; n?: number } = {}): Promise<{ order: BackofficeOrder; quote: BackofficeQuote; ids: Awaited<ReturnType<typeof jobFor>> }> {
  const ids = await jobFor(agent, opts);
  const q = await newQuote(agent, ids.jobId);
  const saved = await save(agent, q, { designs: [unit(), unit({ id: 'u2', label: 'Den', productId: 'wc-picture', quantity: 1, widthIn: 60, heightIn: 48, layout: layoutForStyle('picture', 60), gridType: 'none', options: {} })] });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const accepted = await agent.post(`${BASE}/quotes/${q.id}/accept`);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  return { order: accepted.body as BackofficeOrder, quote: saved.body as BackofficeQuote, ids };
}

describe('the gate and the roles', () => {
  it('is a 404 everywhere for a company without the back office, and a 401 signed out', async () => {
    const owner = await who.as('owner', 'b');
    for (const path of ['/catalog', '/settings', '/quotes', '/orders']) expect((await owner.get(`${BASE}${path}`)).status, path).toBe(404);
    expect((await owner.put(`${BASE}/catalog`).send({})).status).toBe(404);
    expect((await request(t.app).get(`${BASE}/catalog`)).status).toBe(401);
    // Turning it on opens it; off again closes it.
    await setBackoffice(t.seed.b.companyId, true);
    expect((await owner.get(`${BASE}/catalog`)).status).toBe(200);
    await setBackoffice(t.seed.b.companyId, false);
    expect((await owner.get(`${BASE}/orders`)).status).toBe(404);
  });

  it('puts backofficeEnabled in the signed-in company payload', async () => {
    expect((await (await who.as('owner')).get('/api/auth/me')).body.company.backofficeEnabled).toBe(true);
    expect((await (await who.as('owner', 'b')).get('/api/auth/me')).body.company.backofficeEnabled).toBe(false);
  });

  it('lets everyone read the catalog and settings; only owner and office save them (the version goes up each save)', async () => {
    const rep = await who.as('rep');
    const office = await who.as('office');
    const first = await rep.get(`${BASE}/catalog`);
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(0);
    expect(first.body.products.length).toBeGreaterThan(5);
    expect((await rep.get(`${BASE}/settings`)).body.templates).toHaveLength(10);

    const edit: Omit<ProductCatalog, 'version'> = { ...DEFAULT_PRODUCT_CATALOG, maxRepDiscountPercent: 5 };
    expect((await rep.put(`${BASE}/catalog`).send(edit)).status).toBe(403);
    const saved = await office.put(`${BASE}/catalog`).send(edit);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ version: 1, maxRepDiscountPercent: 5 });
    expect((await office.put(`${BASE}/catalog`).send(edit)).body.version).toBe(2);
    // A price book with a duplicate id, or an unknown field, is refused.
    const dupe = { ...edit, products: [edit.products[0], edit.products[0]] };
    expect((await office.put(`${BASE}/catalog`).send(dupe)).status).toBe(400);
    expect((await office.put(`${BASE}/catalog`).send({ ...edit, surprise: 1 })).status).toBe(400);

    const settings = (await office.get(`${BASE}/settings`)).body;
    expect((await rep.put(`${BASE}/settings`).send(settings)).status).toBe(403);
    settings.templates[0].sms = 'Hi {first}, welcome to {company}!';
    settings.stuckDays.sold = 9;
    const put = await office.put(`${BASE}/settings`).send(settings);
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.templates[0].sms).toBe('Hi {first}, welcome to {company}!');
    expect(put.body.stuckDays.sold).toBe(9);
  });
});

describe('quotes', () => {
  it('start with the auto-added extras; the server prices every unit and ignores a tampered total', async () => {
    const rep = await who.as('rep');
    const { jobId } = await jobFor(rep, { assignTo: t.seed.a.rep.userId });
    const q = await newQuote(rep, jobId);
    expect(q).toMatchObject({ status: 'draft', tier: 'better', designs: [], orderId: null });
    expect(q.accessories.map((a) => a.accessoryId)).toEqual(['acc-capping', 'acc-disposal']);

    // The client sends back a whole quote with a forged total and forged lines: only the drawings count.
    const forged = { ...q, designs: [unit()], totals: { better: { subtotalCents: 1, markupCents: 0, discountCents: 0, totalCents: 1 } }, lines: { good: [], better: [], best: [] } };
    const res = await save(rep, q, forged);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const view = res.body as BackofficeQuote;
    // 95 UI -> 44500 + bronze 6500 + colonial 12 lites x 350 = 55200 a unit, two units; capping 2 x 18500; disposal 2 x 3500; better tier +14% on the base.
    expect(view.lines.good[0]).toMatchObject({ designId: 'u1', quantity: 2, unitCents: 55200, amountCents: 110400 });
    expect(view.lines.good.slice(1).map((l) => l.amountCents)).toEqual([37000, 7000]);
    expect(view.totals.good.totalCents).toBe(110400 + 37000 + 7000);
    expect(view.totals.better.totalCents).toBeGreaterThan(view.totals.good.totalCents);
    expect(view.totals.better.totalCents).not.toBe(1);
    expect(view.lines.good[0]!.description).toContain('Kitchen: WinChoice Double Hung 35 1/2 x 59 1/2, Bronze exterior, Colonial grids 3x2');
    expect(view.catalogVersion).toBe(0);
    expect(view.issues.filter((i) => i.level === 'error')).toEqual([]);
    // A read gives the same server-priced view.
    expect((await rep.get(`${BASE}/quotes/${q.id}`)).body.totals).toEqual(view.totals);
  });

  it('report problems with a drawing (and still save it), and the discount flag over the rep limit', async () => {
    const owner = await who.as('owner');
    const { jobId } = await jobFor(owner);
    const q = await newQuote(owner, jobId);
    const res = await save(owner, q, { designs: [unit({ widthIn: 80 })], discountPercent: 15 });
    expect(res.status).toBe(200);
    expect(res.body.issues.some((i: { level: string; message: string }) => i.level === 'error' && i.message.includes('Too wide'))).toBe(true);
    expect(res.body.discountNeedsApproval).toBe(true);
    // A shape the server cannot read is a 400.
    expect((await save(owner, q, { designs: [{ id: 'x' }] })).status).toBe(400);
    expect((await save(owner, q, { tier: 'platinum' })).status).toBe(400);
  });

  it('are listed and read only by people who may see the job; another company never sees them', async () => {
    const mine = await who.as('rep');
    const other = await who.as('otherRep');
    const { jobId } = await jobFor(mine, { assignTo: t.seed.a.rep.userId });
    const q = await newQuote(mine, jobId);
    expect((await mine.get(`${BASE}/quotes`)).body.map((x: { id: string }) => x.id)).toEqual([q.id]);
    expect((await mine.get(`${BASE}/quotes?jobId=${jobId}`)).body).toHaveLength(1);
    expect((await other.get(`${BASE}/quotes/${q.id}`)).status).toBe(404);
    expect((await other.get(`${BASE}/quotes`)).body).toEqual([]);
    expect((await other.post(`${BASE}/quotes`).send({ jobId })).status).toBe(404);
    expect((await (await who.as('owner')).get(`${BASE}/quotes/${q.id}`)).status).toBe(200);
    // Company B has it on too, and still cannot see A's quote, order or job.
    await setBackoffice(t.seed.b.companyId, true);
    const b = await who.as('owner', 'b');
    expect((await b.get(`${BASE}/quotes/${q.id}`)).status).toBe(404);
    expect((await b.get(`${BASE}/quotes`)).body).toEqual([]);
    expect((await b.post(`${BASE}/quotes`).send({ jobId })).status).toBe(404);
    expect((await b.get(`${BASE}/quotes/${q.id}/documents/quote`)).status).toBe(404);
  });

  it('start from the measured sizes of the address (sizeSource measured), with the order size and the options of each line', async () => {
    const owner = await who.as('owner');
    const HOUSE: Ring = [[-96.0, 41.25], [-95.9997, 41.25], [-95.9997, 41.2502], [-96.0, 41.2502], [-96.0, 41.25]];
    const INSIDE: LngLat = [-95.99985, 41.2501];
    await seedFootprintFixture(t.deps.pools, [{ sourceRef: 'house-1', ring: HOUSE }]);
    const ids = await jobFor(owner);
    await sql(`update properties set geom = ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326) where id = $3`, [INSIDE[0], INSIDE[1], ids.propertyId]);
    expect((await owner.post(`${BASE}/quotes`).send({ jobId: ids.jobId, importMeasured: true })).status).toBe(422);
    const created = await owner.post('/api/window-measurements').send({ propertyId: ids.propertyId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const m = created.body as WindowMeasurementView;
    const photo = windowPhoto();
    const up = await owner.post(`/api/window-measurements/${m.id}/uploads`).attach('photo', Buffer.from(photo.bytes), 'w.jpg');
    expect(up.status).toBe(201);
    const patched = await owner.patch(`/api/window-measurements/${m.id}`).send({
      photoWindows: [{ id: 'p1', uploadId: up.body.id, label: 'Kitchen', corners: photo.window, scale: { kind: 'reference', reference: 'letter', corners: photo.paper } }],
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const drafted = await owner.post(`/api/window-measurements/${m.id}/order`);
    expect(drafted.status).toBe(201);
    await owner.patch(`/api/window-orders/${drafted.body.id}`).send({ lines: [{ id: drafted.body.lines[0].id, style: 'double-hung', frameExterior: 'bronze' }] });

    const q = await newQuote(owner, ids.jobId, { importMeasured: true });
    expect(q.designs).toHaveLength(1);
    const d = q.designs[0]!;
    expect(d).toMatchObject({ label: 'Kitchen', productId: 'wc-double-hung', quantity: 1, sizeSource: { kind: 'measured', windowMeasurementId: m.id }, options: { 'exterior-color': 'ext-bronze' } });
    const order = drafted.body.checked[0].order as { widthIn: number; heightIn: number };
    expect(d.widthIn).toBe(order.widthIn);
    expect(d.heightIn).toBe(order.heightIn);
    expect(q.lines.good[0]!.amountCents).toBeGreaterThan(0);
    // Another address's measurement is not this job's.
    const other = await jobFor(owner, { n: 2 });
    expect((await owner.post(`${BASE}/quotes`).send({ jobId: other.jobId, windowMeasurementId: m.id })).status).toBe(422);
  });
});

describe('accepting a quote', () => {
  it('makes the order at sold, wins the job at the sold value, and locks the quote', async () => {
    const owner = await who.as('owner');
    const { order, quote, ids } = await acceptedOrder(owner);
    expect(order).toMatchObject({ stage: 'sold', units: 3, totalCents: quote.totals.better.totalCents, jobId: ids.jobId, quoteId: quote.id, customerName: 'Dana Roe', daysInStage: 0, windowOrderId: null });
    expect(order.events).toHaveLength(1);
    expect(order.events[0]).toMatchObject({ stage: 'sold', note: 'Quote accepted', notified: null });
    const [job] = await sql(`select stage, value_cents from jobs where id = $1`, [ids.jobId]);
    expect(job).toMatchObject({ stage: 'won', value_cents: order.totalCents });

    const again = await owner.post(`${BASE}/quotes/${quote.id}/accept`);
    expect(again.status).toBe(409);
    const edit = await save(owner, quote, { discountPercent: 1 });
    expect(edit.status).toBe(409);
    const read = (await owner.get(`${BASE}/quotes/${quote.id}`)).body as BackofficeQuote;
    expect(read).toMatchObject({ status: 'accepted', orderId: order.id });

    // The accepted prices stay when the price book changes.
    const office = await who.as('office');
    const catalog = (await office.get(`${BASE}/catalog`)).body as ProductCatalog;
    const pricier = { ...catalog, products: catalog.products.map((p) => (p.id === 'wc-double-hung' ? { ...p, perExtraSectionCents: { good: 1, better: 1, best: 1 } } : p)), accessories: catalog.accessories.map((a) => ({ ...a, cents: a.cents * 2 })) };
    await office.put(`${BASE}/catalog`).send(pricier);
    expect((await owner.get(`${BASE}/quotes/${quote.id}`)).body.totals).toEqual(read.totals);
  });

  it('refuses an empty quote or one with problems, and a rep discount over the limit (the office may accept it)', async () => {
    const rep = await who.as('rep');
    const office = await who.as('office');
    const { jobId } = await jobFor(rep, { assignTo: t.seed.a.rep.userId });
    const q = await newQuote(rep, jobId);
    expect((await rep.post(`${BASE}/quotes/${q.id}/accept`)).status).toBe(422);
    await save(rep, q, { designs: [unit({ widthIn: 90 })] });
    const bad = await rep.post(`${BASE}/quotes/${q.id}/accept`);
    expect(bad.status).toBe(422);
    expect(bad.body.error).toContain('Fix the problems');
    await save(rep, q, { designs: [unit()], discountPercent: 15 });
    const over = await rep.post(`${BASE}/quotes/${q.id}/accept`);
    expect(over.status).toBe(403);
    expect(over.body.error).toContain('10%');
    const ok = await office.post(`${BASE}/quotes/${q.id}/accept`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const view = (await office.get(`${BASE}/quotes/${q.id}`)).body as BackofficeQuote;
    expect(ok.body.totalCents).toBe(view.totals.better.totalCents);
    expect(view.totals.better.discountCents).toBeGreaterThan(0);
  });
});

describe('orders and stage moves', () => {
  it('shows the board with days in stage, and an order with its events', async () => {
    const owner = await who.as('owner');
    const { order } = await acceptedOrder(owner);
    t.clock.advance(5 * 24 * 3600 * 1000);
    const board = (await owner.get(`${BASE}/orders`)).body as BackofficeOrder[];
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ id: order.id, stage: 'sold', daysInStage: 5 });
    expect((await owner.get(`${BASE}/orders?stage=measured`)).body).toEqual([]);
    expect((await owner.get(`${BASE}/orders?stage=nope`)).status).toBe(400);
    const one = (await owner.get(`${BASE}/orders/${order.id}`)).body as BackofficeOrder;
    expect(one.events.map((e) => e.stage)).toEqual(['sold']);
    expect((await (await who.as('otherRep')).get(`${BASE}/orders/${order.id}`)).status).toBe(404);
  });

  it('only owner and office move an order', async () => {
    const owner = await who.as('owner');
    const { order } = await acceptedOrder(owner);
    const body = { stage: 'measured', note: '', plannedFor: null, notify: false };
    expect((await (await who.as('rep')).patch(`${BASE}/orders/${order.id}/stage`).send(body)).status).toBe(403);
    expect((await (await who.as('office')).patch(`${BASE}/orders/${order.id}/stage`).send(body)).status).toBe(200);
    for (const bad of [{ ...body, stage: 'flying' }, { ...body, plannedFor: 'tomorrow' }, { ...body, plannedFor: '2026-02-31' }, { stage: 'built' }, { ...body, extra: 1 }]) {
      expect((await owner.patch(`${BASE}/orders/${order.id}/stage`).send(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await owner.patch(`${BASE}/orders/00000000-0000-4000-8000-000000000000/stage`).send(body)).status).toBe(404);
  });

  it('records the move without telling the customer when notify is off', async () => {
    const owner = await who.as('owner');
    const { order } = await acceptedOrder(owner);
    const res = await owner.patch(`${BASE}/orders/${order.id}/stage`).send({ stage: 'measure-booked', note: 'Booked for Monday', plannedFor: '2026-10-19', notify: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const o = res.body as BackofficeOrder;
    expect(o.stage).toBe('measure-booked');
    expect(o.events.at(-1)).toMatchObject({ stage: 'measure-booked', note: 'Booked for Monday', plannedFor: '2026-10-19', notified: null, byUserName: expect.any(String) });
    expect(t.sms.sent).toHaveLength(0);
    expect(t.mailer.sent).toHaveLength(0);
  });

  it('texts and emails the customer with the stage template when they agreed to texts', async () => {
    const owner = await who.as('owner');
    const { order } = await acceptedOrder(owner, { consent: 'express' });
    const res = await owner.patch(`${BASE}/orders/${order.id}/stage`).send({ stage: 'install-scheduled', note: '', plannedFor: '2026-10-20', notify: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.events.at(-1).notified).toEqual({ sms: 'sent', email: 'sent' });
    expect(t.sms.sent).toHaveLength(1);
    expect(t.sms.sent[0]).toMatchObject({ to: '+14025550111' });
    expect(t.sms.sent[0]!.body).toContain('Hi Dana, your install is scheduled: Tue, Oct 20.');
    expect(t.mailer.sent).toEqual([expect.objectContaining({ to: 'dana@example.test', subject: 'Your install day is scheduled' })]);
    expect(t.mailer.sent[0]!.text).toContain('Tue, Oct 20');
    const [row] = await sql(`select purpose, status, direction from messages where company_id = $1`, [t.seed.a.companyId]);
    expect(row).toMatchObject({ purpose: 'informational', status: 'sent', direction: 'out' });
  });

  it.each(['none', 'revoked'])('sends no text to a customer whose texting consent is %s (the email still goes)', async (consent) => {
    const owner = await who.as('owner');
    const { order } = await acceptedOrder(owner, { consent });
    const res = await owner.patch(`${BASE}/orders/${order.id}/stage`).send({ stage: 'ordered', note: '', plannedFor: null, notify: true });
    expect(res.status).toBe(200);
    expect(res.body.events.at(-1).notified).toEqual({ sms: 'skipped-no-consent', email: 'sent' });
    expect(t.sms.sent).toHaveLength(0);
    expect(res.body.stage).toBe('ordered');
  });

  it('sends nothing when a stage message is switched off, and no email to an opted-out address', async () => {
    const owner = await who.as('owner');
    const { order, ids } = await acceptedOrder(owner);
    const settings = (await owner.get(`${BASE}/settings`)).body;
    settings.templates = settings.templates.map((x: { stage: string }) => (x.stage === 'built' ? { ...x, enabled: false } : x));
    await owner.put(`${BASE}/settings`).send(settings);
    const off = await owner.patch(`${BASE}/orders/${order.id}/stage`).send({ stage: 'built', note: '', plannedFor: null, notify: true });
    expect(off.body.events.at(-1).notified).toEqual({ sms: 'off', email: 'off' });
    await sql(`insert into email_opt_outs (company_id, email, source) values ($1, 'dana@example.test', 'manual')`, [t.seed.a.companyId]);
    const on = await owner.patch(`${BASE}/orders/${order.id}/stage`).send({ stage: 'shipped', note: '', plannedFor: '2026-10-21', notify: true });
    expect(on.body.events.at(-1).notified).toEqual({ sms: 'sent', email: 'off' });
    expect(ids.customerId).toBeTruthy();
  });

  it('marks a failed text without undoing the move', async () => {
    const owner = await who.as('owner');
    const { order } = await acceptedOrder(owner);
    t.sms.failNext(1);
    const res = await owner.patch(`${BASE}/orders/${order.id}/stage`).send({ stage: 'ordered', note: '', plannedFor: null, notify: true });
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('ordered');
    expect(res.body.events.at(-1).notified.sms).toBe('failed');
  });

  it('moves the job to installed with the order, and an event cannot be rewritten', async () => {
    const owner = await who.as('owner');
    const { order, ids } = await acceptedOrder(owner);
    await owner.patch(`${BASE}/orders/${order.id}/stage`).send({ stage: 'installed', note: '', plannedFor: null, notify: false });
    expect((await sql(`select stage from jobs where id = $1`, [ids.jobId]))[0]!.stage).toBe('installed');
    await expect(inCompany(t, t.seed.a.companyId, (tx) => tx.execute(dsql`update backoffice_order_events set note = 'x'`))).rejects.toThrow();
    await inCompany(t, t.seed.a.companyId, (tx) => tx.execute(dsql`update backoffice_order_events set notified = null`));
  });
});

describe('the homeowner app status', () => {
  it('follows the order stage (HOMEOWNER_STAGE_FOR) once the office moves it', async () => {
    const owner = await who.as('owner');
    const { order, ids } = await acceptedOrder(owner);
    // The homeowner's request, filed with the company, points at this job.
    const token = 'a'.repeat(43);
    await sql(`update company_settings set quote_enabled = true, quote_slug = 'acme-app' where company_id = $1`, [t.seed.a.companyId]);
    const [filed] = await sql(
      `insert into quote_requests (company_id, first_name, last_name, email, phone_e164, postal_code, products, consent_text, consent_version, consent_at, customer_id, job_id, created_at, updated_at)
       values ($1, 'Dana', 'Roe', 'dana@example.test', '+14025550111', '68102', '{windows}', 'x', 'v1', $4, $2, $3, $4, $4) returning id`,
      [t.seed.a.companyId, ids.customerId, ids.jobId, new Date(NOW.getTime() - 86_400_000).toISOString()],
    );
    const [req] = await sql(
      `insert into homeowner_requests (company_id, token_hash, expires_at, services, address, status, quote_request_id) values ($1, $2, $3, '{windows}', '4810 Underwood Ave', 'ready', $4) returning id`,
      [t.seed.a.companyId, sha256(token), new Date(NOW.getTime() + 86_400_000).toISOString(), filed!.id],
    );
    let n = 0;
    const status = async () => (await request(t.app).get(`/api/public/homeowner/acme-app/requests/${req!.id}/status`).set('X-Forwarded-For', `10.0.0.${(n += 1)}`).set('Authorization', `Bearer ${token}`)).body;
    expect(await status()).toMatchObject({ stage: 'visit-booked' }); // sold
    const move = (stage: string) => owner.patch(`${BASE}/orders/${order.id}/stage`).send({ stage, note: '', plannedFor: null, notify: false });
    await move('measured');
    expect(await status()).toMatchObject({ stage: 'measured', dates: { measuredAt: expect.any(String) } });
    await move('in-production');
    expect(await status()).toMatchObject({ stage: 'ordered', dates: { orderedAt: expect.any(String) } });
    await move('built');
    expect((await status()).stage).toBe('built');
    await move('install-scheduled');
    expect((await status()).stage).toBe('shipped');
    await move('complete');
    expect(await status()).toMatchObject({ stage: 'installed', dates: { installedAt: expect.any(String) } });
  });
});

describe('the house picture', () => {
  it('keeps a photo (JPEG or PNG, checked by its bytes) and the placed units, and serves the photo back', async () => {
    const owner = await who.as('owner');
    const { jobId } = await jobFor(owner);
    const q = await newQuote(owner, jobId);
    await save(owner, q, { designs: [unit(), unit({ id: 'u2' })] });
    const empty = await owner.get(`${BASE}/quotes/${q.id}/visual`);
    expect(empty.body).toMatchObject({ quoteId: q.id, photoUploadId: null, placements: [] });
    expect((await owner.get(`${BASE}/quotes/${q.id}/visual/photo`)).status).toBe(404);

    expect((await owner.post(`${BASE}/quotes/${q.id}/visual/photo`).attach('photo', Buffer.from('not a picture'), 'x.jpg')).status).toBe(415);
    expect((await owner.post(`${BASE}/quotes/${q.id}/visual/photo`)).status).toBe(400);
    const up = await owner.post(`${BASE}/quotes/${q.id}/visual/photo`).attach('photo', Buffer.from(greyJpeg(800, 600)), 'house.jpg');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body).toMatchObject({ widthPx: 800, heightPx: 600 });

    const corners = [[0.1, 0.1], [0.3, 0.1], [0.3, 0.4], [0.1, 0.4]];
    const put = await owner.put(`${BASE}/quotes/${q.id}/visual`).send({ photoUploadId: up.body.id, placements: [{ id: 'pl1', designId: 'u1', corners }] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ quoteId: q.id, photoUploadId: up.body.id, placements: [{ id: 'pl1', designId: 'u1', corners }] });
    expect((await owner.get(`${BASE}/quotes/${q.id}/visual`)).body.placements).toHaveLength(1);
    const photo = await owner.get(`${BASE}/quotes/${q.id}/visual/photo`);
    expect(photo.status).toBe(200);
    expect(photo.headers['content-type']).toBe('image/jpeg');

    // A placement of a unit that is not on the quote, a photo that is not this address's, and a bad corner are refused.
    expect((await owner.put(`${BASE}/quotes/${q.id}/visual`).send({ photoUploadId: up.body.id, placements: [{ id: 'pl1', designId: 'nope', corners }] })).status).toBe(400);
    expect((await owner.put(`${BASE}/quotes/${q.id}/visual`).send({ photoUploadId: '11111111-1111-4111-8111-111111111111', placements: [] })).status).toBe(400);
    expect((await owner.put(`${BASE}/quotes/${q.id}/visual`).send({ photoUploadId: null, placements: [{ id: 'p', designId: 'u1', corners: [[0, 0]] }] })).status).toBe(400);
    // Another company cannot reach it.
    await setBackoffice(t.seed.b.companyId, true);
    expect((await (await who.as('owner', 'b')).get(`${BASE}/quotes/${q.id}/visual/photo`)).status).toBe(404);
    // Clearing the photo removes it.
    expect((await owner.put(`${BASE}/quotes/${q.id}/visual`).send({ photoUploadId: null, placements: [] })).body.photoUploadId).toBeNull();
    expect((await owner.get(`${BASE}/quotes/${q.id}/visual/photo`)).status).toBe(404);
  });
});

describe('documents', () => {
  const KINDS = ['quote', 'order-confirmation', 'factory-order', 'install-sheet'] as const;

  async function pdf(agent: SuperAgent, quoteId: string, kind: string) {
    return agent.get(`${BASE}/quotes/${quoteId}/documents/${kind}`).buffer(true).parse((res, cb) => {
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => parts.push(d));
      res.on('end', () => cb(null, Buffer.concat(parts)));
    });
  }

  it.each(KINDS)('%s is a PDF of a sane size, for an open quote and for an accepted one', async (kind) => {
    const owner = await who.as('owner');
    const ids = await jobFor(owner);
    const draft = await newQuote(owner, ids.jobId);
    const units = [
      unit(),
      unit({ id: 'u2', label: 'Family room', productId: 'wc-slider-3', widthIn: 96, heightIn: 48, quantity: 1, layout: layoutForStyle('slider-3', 96), gridType: 'none', options: {} }),
      unit({ id: 'u3', label: 'Foyer', productId: 'wc-arch-top', shape: 'arch-top', widthIn: 36, heightIn: 30, quantity: 1, layout: layoutForStyle('arch', 36), gridType: 'none', options: { 'exterior-color': 'ext-clay' } }),
      unit({ id: 'u4', label: 'Back door', productId: 'wc-patio-door', widthIn: 72, heightIn: 80, quantity: 1, gridType: 'none', options: {}, layout: { kind: 'split', id: 'r', direction: 'columns', parts: [{ size: 36, layout: { kind: 'section', id: 'a', opening: 'door-fixed', grid: '' } }, { size: null, layout: { kind: 'section', id: 'b', opening: 'door-slide-left', grid: '' } }] } }),
      unit({ id: 'u5', label: 'Bath', productId: 'wc-casement', widthIn: 48, heightIn: 36, quantity: 1, layout: { kind: 'split', id: 'r', direction: 'columns', parts: [{ size: 24, layout: { kind: 'section', id: 'a', opening: 'casement-left', grid: '' } }, { size: null, layout: { kind: 'section', id: 'b', opening: 'casement-right', grid: '' } }] }, gridType: 'none', options: {}, safety: { besideDoor: false, wetArea: true, sillHeightIn: 30, walkway: null } }),
    ];
    const saved = await save(owner, draft, { designs: units });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const open = await pdf(owner, draft.id, kind);
    expect(open.status).toBe(200);
    expect(open.headers['content-type']).toBe('application/pdf');
    const body = open.body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(body.length).toBeGreaterThan(3_000);
    expect(body.length).toBeLessThan(2_000_000);

    const accepted = await owner.post(`${BASE}/quotes/${draft.id}/accept`);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    const final = await pdf(owner, draft.id, kind);
    expect(final.status).toBe(200);
    expect((final.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((final.body as Buffer).length).toBeLessThan(2_000_000);
  });

  it('refuses an unknown document and one for a quote the member cannot see', async () => {
    const owner = await who.as('owner');
    const { jobId } = await jobFor(owner);
    const q = await newQuote(owner, jobId);
    expect((await owner.get(`${BASE}/quotes/${q.id}/documents/invoice`)).status).toBe(404);
    expect((await (await who.as('otherRep')).get(`${BASE}/quotes/${q.id}/documents/quote`)).status).toBe(404);
  });

  it('handles an empty quote', async () => {
    const owner = await who.as('owner');
    const { jobId } = await jobFor(owner);
    const q = await newQuote(owner, jobId);
    for (const kind of KINDS) expect((await pdf(owner, q.id, kind)).status, kind).toBe(200);
  });
});

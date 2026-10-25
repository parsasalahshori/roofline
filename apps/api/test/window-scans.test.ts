import { readFileSync } from 'node:fs';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { insertFootprints } from '@roofline/db/system';
import {
  type HomeownerCreated,
  type HomeownerRequestView,
  type LngLat,
  quadkeyOf,
  type Ring,
  type ScanDetailView,
  type ScanFrame,
  type ScanMark,
  type ScanQueueView,
  type ScanResult,
  type SolarBuilding,
} from '@roofline/shared';
import { seedFootprintFixture } from '../src/scripts/footprint-fixture.ts';
import { arCorners, boxCorners, greyJpeg } from './homeowner-fixture.ts';
import { loginAs, makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

/*
 * The multi-frame window scan (docs/windows/scan-contract.md): the phone's POST .../scans (validation, the server's own
 * triangulation and gates, idempotency, auto-accept), the window's size and the homeowner's view of it, and the staff
 * review queue (junior, then senior; override, visit required, expedite, SLA, company isolation). Against a real
 * database with the fake providers. Needs Docker.
 */

const NOW = new Date('2026-10-25T15:00:00.000Z');
const ACME = 'acme-scan';
const BOLT = 'bolt-scan';
const ADDRESS = '4810 Underwood Ave, Omaha, NE 68132';
const HOUR = 60 * 60 * 1000;

let owner: pg.Pool;
let t: TestApp;
const q = async (text: string, values: unknown[] = []) => (await owner.query(text, values)).rows;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

/* -- a company with the homeowner page on, and a house ------------------------------------------------------------- */

async function enable(companyId: string, slug: string): Promise<void> {
  await q(
    `insert into company_settings (company_id, quote_enabled, quote_slug, quote_products) values ($1, true, $2, $3)
     on conflict (company_id) do update set quote_enabled = true, quote_slug = excluded.quote_slug, quote_products = excluded.quote_products`,
    [companyId, slug, ['windows', 'roof']],
  );
}

async function houseAt(address: string): Promise<void> {
  const found = await t.deps.geocoder.geocode(address);
  const [lng, lat] = [found!.lng, found!.lat];
  const [dx, dy] = [0.00012, 0.00008];
  const ring: Ring = [
    [lng - dx, lat - dy],
    [lng + dx, lat - dy],
    [lng + dx, lat + dy],
    [lng - dx, lat + dy],
    [lng - dx, lat - dy],
  ];
  const tile = quadkeyOf(ring[0]![0], ring[0]![1]);
  const [ready] = await q(`select 1 from building_footprint_tiles where quadkey = $1`, [tile]);
  if (ready) await insertFootprints(t.deps.pools.system, { tile, state: 'NE' }, [{ sourceRef: `house-${address}`, ring }]);
  else await seedFootprintFixture(t.deps.pools, [{ sourceRef: `house-${address}`, ring }]);
  const at: LngLat = [lng, lat];
  const building: SolarBuilding = {
    center: at,
    box: { sw: [lng - dx, lat - dy], ne: [lng + dx, lat + dy] },
    imageryQuality: 'HIGH',
    imageryDate: '2025-06-01',
    segments: [{ pitchDeg: 26.6, azimuthDeg: 180, areaM2: 200, groundAreaM2: 180, center: at, box: null }],
  };
  t.solar.set(at, building);
}

beforeEach(async () => {
  t = await makeTestApp({ TRUST_PROXY: 1 });
  t.clock.set(NOW);
  await enable(t.seed.a.companyId, ACME);
  await enable(t.seed.b.companyId, BOLT);
  await houseAt(ADDRESS);
});
afterEach(async () => {
  await t.close();
});

let ipCounter = 0;
const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;
const base = (slug = ACME) => `/api/public/homeowner/${slug}`;

type Started = { id: string; token: string };
function send(method: 'get' | 'post', s: Started | null, path: string, body?: unknown, slug = ACME) {
  let req = request(t.app)[method](`${base(slug)}${path}`).set('X-Forwarded-For', nextIp());
  if (s !== null) req = req.set('Authorization', `Bearer ${s.token}`);
  return body === undefined ? req : req.send(body as object);
}
async function start(slug = ACME): Promise<Started> {
  const res = await send('post', null, '/requests', { address: ADDRESS, services: ['windows'] }, slug);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const b = res.body as HomeownerCreated;
  return { id: b.requestId, token: b.token };
}
const homeView = async (s: Started): Promise<HomeownerRequestView> => {
  const res = await send('get', s, `/requests/${s.id}`);
  expect(res.status).toBe(200);
  return res.body as HomeownerRequestView;
};
async function upload(s: Started, slug = ACME): Promise<string> {
  const res = await request(t.app)
    .post(`${base(slug)}/requests/${s.id}/uploads`)
    .set('X-Forwarded-For', nextIp())
    .set('Authorization', `Bearer ${s.token}`)
    .set('Content-Type', 'image/jpeg')
    .send(Buffer.from(greyJpeg(1920, 1440)));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
}
/** The window the phone sent first: a 40 x 50 in single-photo AR window, so a scan's size is plainly different. */
async function addWindow(s: Started, id = 'w1'): Promise<void> {
  const photo = await upload(s);
  const res = await send('post', s, `/requests/${s.id}/windows`, {
    id,
    room: 'Kitchen',
    label: 'Sink window',
    style: 'double-hung',
    scale: { kind: 'ar', pointsM: arCorners(40, 50), trackingLostCount: 0, device: 'arkit-lidar' },
    uploadId: photo,
    corners: boxCorners(1920, 1440),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

/* -- scans from the shared fixtures (the same files the iOS code checks) ------------------------------------------- */

type Fixture = { input: { frames: ScanFrame[]; marks: ScanMark[]; wall: unknown }; expected: { status: 'measured' | 'needs_review'; failed: string[]; widthIn: number | null; heightIn: number | null; cornersM: number[][] | null; quality: ScanResult['quality'] } };
const fixture = (name: string): Fixture => JSON.parse(readFileSync(new URL(`../../../packages/shared/test/fixtures/window-scan/${name}.json`, import.meta.url), 'utf8')) as Fixture;

/** The body a phone would send for a fixture: its frames uploaded for real, its own result as the phone's. */
async function scanBody(s: Started, fx: Fixture, over: Record<string, unknown> = {}, slug = ACME): Promise<ScanBodyJson> {
  const frames = [];
  for (const f of fx.input.frames) frames.push({ ...f, uploadId: await upload(s, slug) });
  const e = fx.expected;
  return {
    scanId: '5c0d7a52-1d3c-4a53-9d4e-0a6a5e0f1a01',
    windowId: 'w1',
    app: '0.1.0 (2610251200)',
    device: 'iPhone17,2',
    wall: fx.input.wall,
    frames,
    marks: fx.input.marks,
    result: { cornersM: e.cornersM, widthIn: e.widthIn, heightIn: e.heightIn, windowFrame: null, quality: e.quality, status: e.status },
    ...over,
  };
}
/** A scan body as sent: loosely typed on purpose (the tests bend it). */
type ScanBodyJson = Record<string, unknown> & { frames: ScanFrame[]; marks: ScanMark[]; result: { quality: ScanResult['quality'] } & Record<string, unknown> };
const postScan = (s: Started, body: unknown) => send('post', s, `/requests/${s.id}/scans`, body);

async function scanned(fx: string, over: Record<string, unknown> = {}): Promise<{ s: Started; body: ScanBodyJson; res: request.Response }> {
  const s = await start();
  await addWindow(s);
  const body = await scanBody(s, fixture(fx), over);
  const res = await postScan(s, body);
  return { s, body, res };
}

const windowOf = (v: HomeownerRequestView, id = 'w1') => v.windows.find((w) => w.id === id)!;
const near = (a: number, b: number, tol: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

/* ------------------------------------------------------------------------------------------------------------------ */

describe('POST .../scans: the phone sends a scan', () => {
  test('a clean scan is accepted at once: the server answers its own result, and the window takes the scan size', async () => {
    const { s, res } = await scanned('clean-34x55');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ scanId: '5c0d7a52-1d3c-4a53-9d4e-0a6a5e0f1a01', status: 'measured', result: { status: 'measured', quality: { failed: [], closeups: 4, framesPerCorner: [6, 6, 6, 6] } } });
    near(res.body.result.widthIn, 34.625, 0.0625);
    near(res.body.result.heightIn, 55.75, 0.0625);
    expect(res.body.result.cornersM).toHaveLength(4);
    // The window was 40 x 50 from one photo; now it is the scan's opening, 'good'
    const w = windowOf(await homeView(s));
    near(w.widthIn, 34.625, 0.0625);
    near(w.heightIn, 55.75, 0.0625);
    expect(w.quality).toBe('good');
    expect(w.reasons).toEqual([]);
    expect(w.scan).toMatchObject({ state: 'measured', label: 'Measured' });
    const [row] = await q(`select status, sla_due_at, outcome, history from window_scans where company_id = $1`, [t.seed.a.companyId]);
    expect(row).toMatchObject({ status: 'measured', outcome: null });
    expect((row!.history as { action: string }[]).map((h) => h.action)).toEqual(['created', 'auto_accepted']);
    expect(new Date(row!.sla_due_at).getTime()).toBe(NOW.getTime() + 24 * HOUR);
  });

  test('the same scan sent again is the scan already stored (200, one row), and the window can be re-sent too', async () => {
    const { s, body, res } = await scanned('clean-34x55');
    expect(res.status).toBe(201);
    const again = await postScan(s, body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(res.body);
    expect(await q(`select 1 from window_scans where company_id = $1`, [t.seed.a.companyId])).toHaveLength(1);
    // The phone's outbox may send the window again after the scan: the window is still the same window (no 409)
    const win = await send('post', s, `/requests/${s.id}/windows`, {
      id: 'w1',
      room: 'Kitchen',
      label: 'Sink window',
      style: 'double-hung',
      scale: { kind: 'ar', pointsM: arCorners(40, 50), trackingLostCount: 0, device: 'arkit-lidar' },
      uploadId: (await q(`select window_id from window_scans`)).length === 1 ? ((await q(`select adjustments->'photoWindows'->0->>'uploadId' as u from window_measurements`))[0]!.u as string) : '',
      corners: boxCorners(1920, 1440),
    });
    expect(win.status, JSON.stringify(win.body)).toBe(200);
    near(windowOf(win.body as HomeownerRequestView).widthIn, 34.625, 0.0625);
  });

  test('a scan that fails a gate needs review: the window keeps its size and the homeowner is told it is being checked', async () => {
    const { s, res } = await scanned('skewed-corner');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'needs_review', result: { status: 'needs_review', quality: { failed: ['sym_ratio'] } } });
    const w = windowOf(await homeView(s));
    expect(w.widthIn).toBe(40);
    expect(w.heightIn).toBe(50);
    expect(w.scan).toMatchObject({ state: 'checking', label: 'Being checked by WinChoice' });
    const [row] = await q(`select status from window_scans`);
    expect(row!.status).toBe('needs_review');
  });

  test("the server's result wins: a phone claiming 'measured' for a scan with a bad mark is still sent to review", async () => {
    const fx = fixture('bad-mark');
    const s = await start();
    await addWindow(s);
    const body = await scanBody(s, fx, { result: { cornersM: null, widthIn: null, heightIn: null, windowFrame: null, quality: { ...fx.expected.quality, failed: [] }, status: 'measured' } });
    const res = await postScan(s, body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'needs_review', result: { quality: { failed: ['reprojection'] } } });
    // the phone's own claim is kept for comparison
    const [row] = await q(`select phone_result, server_result from window_scans`);
    expect(row!.phone_result.status).toBe('measured');
    expect(row!.server_result.status).toBe('needs_review');
  });

  test("a window the scan names must be one the phone sent, and the frames' photos must be this request's", async () => {
    const s = await start();
    await addWindow(s);
    const body = await scanBody(s, fixture('clean-34x55'));
    const missing = await postScan(s, { ...body, windowId: 'nope' });
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe('window_unknown');
    const foreign = await postScan(s, { ...body, frames: body.frames.map((f: ScanFrame, i: number) => (i === 0 ? { ...f, uploadId: '11111111-2222-4333-8444-555555555555' } : f)) });
    expect(foreign.status).toBe(400);
    expect(foreign.body.field).toBe('frames');
    expect(await q(`select 1 from window_scans`)).toHaveLength(0);
  });

  test('bad bodies are a 400 with nothing stored: unknown keys, too few frames, marks on frames that are not there, a transform that is not rigid, a mark outside its photo', async () => {
    const s = await start();
    await addWindow(s);
    const body = await scanBody(s, fixture('clean-34x55'));
    const cases: [string, Record<string, unknown>][] = [
      ['an unknown key', { ...body, extra: 1 }],
      ['no scan id', { ...body, scanId: 'not-a-uuid' }],
      ['two frames', { ...body, frames: body.frames.slice(0, 2) }],
      ['25 frames', { ...body, frames: Array.from({ length: 25 }, (_, i) => ({ ...body.frames[i % 9], frameId: `x${i}` })) }],
      ['a mark on a frame that is not there', { ...body, marks: [...body.marks, { frameId: 'zzz', corner: 0, x: 10, y: 10, source: 'user' }] }],
      ['a mark outside its photo', { ...body, marks: [{ ...body.marks[0], x: 5000 }, ...body.marks.slice(1)] }],
      ['a transform with 15 numbers', { ...body, frames: [{ ...body.frames[0], cameraTransform: body.frames[0].cameraTransform.slice(1) }, ...body.frames.slice(1)] }],
      ['a transform that is not rigid', { ...body, frames: [{ ...body.frames[0], cameraTransform: body.frames[0].cameraTransform.map((v: number, i: number) => (i === 0 ? 3 : v)) }, ...body.frames.slice(1)] }],
      ['a duplicate frame id', { ...body, frames: [body.frames[0], { ...body.frames[1], frameId: body.frames[0].frameId }, ...body.frames.slice(2)] }],
      ['a mark source nobody sends', { ...body, marks: [{ ...body.marks[0], source: 'magic' }, ...body.marks.slice(1)] }],
      ['an unknown key in a frame', { ...body, frames: [{ ...body.frames[0], depth: 'x' }, ...body.frames.slice(1)] }],
      ['no result', { ...body, result: undefined }],
      ['a result with an unknown gate', { ...body, result: { ...body.result, quality: { ...body.result.quality, failed: ['mystery'] } } }],
    ];
    for (const [name, bad] of cases) {
      const res = await postScan(s, bad);
      expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body.code, name).toBe('invalid_request');
    }
    expect(await q(`select 1 from window_scans`)).toHaveLength(0);
  });

  test('a body over 1 MB is refused (413), a normal one is under 100 KB', async () => {
    const s = await start();
    await addWindow(s);
    const body = await scanBody(s, fixture('clean-34x55'));
    expect(JSON.stringify(body).length).toBeLessThan(100_000);
    const big = await postScan(s, { ...body, app: 'x'.repeat(1_200_000) });
    expect(big.status).toBe(413);
  });

  test('no token, a wrong token, another company\'s page and a callback request are refused', async () => {
    const s = await start();
    await addWindow(s);
    const body = await scanBody(s, fixture('clean-34x55'));
    const none = await request(t.app).post(`${base()}/requests/${s.id}/scans`).set('X-Forwarded-For', nextIp()).send(body);
    expect(none.status).toBe(401);
    expect((await postScan({ id: s.id, token: 'A'.repeat(43) }, body)).status).toBe(401);
    expect((await send('post', s, `/requests/${s.id}/scans`, body, BOLT)).status).toBe(401);
    expect(await q(`select 1 from window_scans`)).toHaveLength(0);
  });

  test('a scan on a window with no photo corners (a room scan) gives it a photo and the scan size', async () => {
    const s = await start();
    const res = await send('post', s, `/requests/${s.id}/windows`, { id: 'w1', room: 'Den', style: 'double-hung', scale: { kind: 'roomplan', widthM: 0.9, heightM: 1.2, confidence: 'high' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = await scanBody(s, fixture('clean-34x55'));
    const scan = await postScan(s, body);
    expect(scan.status, JSON.stringify(scan.body)).toBe(201);
    expect(scan.body.status).toBe('measured');
    const w = windowOf(await homeView(s));
    near(w.widthIn, 34.625, 0.0625);
    expect(w.quality).toBe('good');
    expect(w.uploadId).toBeDefined();
  });
});

/* ------------------------------------------------------------------------------------------------------------------ */

describe('staff: the review queue', () => {
  let owner1: SuperAgent;
  let office: SuperAgent;
  let rep: SuperAgent;

  beforeEach(async () => {
    owner1 = await loginAs(t.app, t.seed.a.owner);
    office = await loginAs(t.app, t.seed.a.office);
    rep = await loginAs(t.app, t.seed.a.rep);
  });

  const queue = async (a: SuperAgent, status = '') => {
    const res = await a.get(`/api/window-scans${status === '' ? '' : `?status=${status}`}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as ScanQueueView;
  };
  const detail = async (a: SuperAgent, id: string) => {
    const res = await a.get(`/api/window-scans/${id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as ScanDetailView;
  };
  const scanId = async () => (await q(`select id from window_scans order by created_at desc limit 1`))[0]!.id as string;
  /** The bad-mark fixture's mark for r2 corner 1 put where the clean scan has it. */
  const fixedMarks = (): ScanMark[] => {
    const clean = fixture('clean-34x55').input.marks;
    return fixture('bad-mark').input.marks.map((m) => (m.frameId === 'r2' && m.corner === 1 ? clean.find((c) => c.frameId === 'r2' && c.corner === 1)! : m));
  };

  test('needs a session; lists scans that need a person with room, homeowner, SLA and the gates that failed; counts per status', async () => {
    const { s } = await scanned('bad-mark');
    expect((await request(t.app).get('/api/window-scans')).status).toBe(401);
    const v = await queue(rep);
    expect(v.counts).toMatchObject({ needs_review: 1, measured: 0 });
    expect(v.scans).toHaveLength(1);
    expect(v.scans[0]).toMatchObject({
      status: 'needs_review',
      room: 'Kitchen',
      label: 'Sink window',
      windowId: 'w1',
      address: expect.stringContaining('Underwood'),
      homeowner: null,
      frameCount: 9,
      failed: ['reprojection'],
      expedite: false,
      overdue: false,
      secondsLeft: 24 * 3600,
    });
    expect(v.scans[0]!.widthIn).toBeGreaterThan(34);
    // Once the homeowner files their details the queue names them
    const contact = await send('post', s, `/requests/${s.id}/contact`, {
      firstName: 'Dana', lastName: 'Whitfield', phone: '(402) 555-0142', email: 'dana.w@example.com', zip: '68132', contactConsent: true, consentVersion: (await send('get', null, '/company')).body.consent.version,
    });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    expect((await queue(rep)).scans[0]!.homeowner).toBe('Dana Whitfield');
    // Filters: done is empty; a status; a bad status is a 400
    expect((await queue(rep, 'done')).scans).toHaveLength(0);
    expect((await queue(rep, 'needs_review')).scans).toHaveLength(1);
    expect((await rep.get('/api/window-scans?status=bogus')).status).toBe(400);
  });

  test('the SLA counts down from the scan and goes red when overdue; an expedited scan goes first and is out of the SLA', async () => {
    await scanned('bad-mark');
    const first = await scanId();
    t.clock.set(new Date(NOW.getTime() + HOUR));
    const second = await scanned('skewed-corner');
    expect(second.res.status).toBe(201);
    // Two windows on separate requests: the older one is first by its SLA
    t.clock.set(new Date(NOW.getTime() + 26 * HOUR));
    let v = await queue(rep);
    expect(v.scans.map((x) => x.id)[0]).toBe(first);
    expect(v.scans.every((x) => x.overdue && x.secondsLeft! < 0)).toBe(true);
    const newest = v.scans.find((x) => x.id !== first)!;
    const ex = await rep.post(`/api/window-scans/${newest.id}/expedite`).send({});
    expect(ex.status, JSON.stringify(ex.body)).toBe(200);
    expect(ex.body).toMatchObject({ expedite: true, secondsLeft: null, overdue: false });
    v = await queue(rep);
    expect(v.scans[0]).toMatchObject({ id: newest.id, expedite: true, secondsLeft: null, overdue: false });
    // And back
    const off = await rep.post(`/api/window-scans/${newest.id}/expedite`).send({ expedite: false });
    expect(off.body.expedite).toBe(false);
    expect((await detail(rep, newest.id)).history.map((h) => h.action)).toEqual(['created', 'expedited', 'unexpedited']);
  });

  test('one scan: frames with picture URLs, the marks (original and now), the server result, the history; the picture itself is served', async () => {
    await scanned('bad-mark');
    const id = await scanId();
    const d = await detail(rep, id);
    expect(d).toMatchObject({ status: 'needs_review', room: 'Kitchen', mayEdit: true, mayFinalize: false, junior: null, senior: null });
    expect(d.frames).toHaveLength(9);
    expect(d.marks).toHaveLength(d.marksOriginal.length);
    expect(d.result.quality.failed).toEqual(['reprojection']);
    expect(d.phoneResult).not.toBeNull();
    const img = await rep.get(d.frames[0]!.imageUrl);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect((await rep.get(`/api/window-scans/${id}/frames/nope/image`)).status).toBe(404);
    expect((await owner1.get(`/api/window-scans/${id}`)).body.mayFinalize).toBe(false);
  });

  test('junior moves a mark (status in_review, result worked out again), submits; the senior finalises measured and the window takes the size', async () => {
    const { s } = await scanned('bad-mark');
    const id = await scanId();
    expect((await detail(rep, id)).result.quality.failed).toEqual(['reprojection']);

    const edit = await rep.patch(`/api/window-scans/${id}/marks`).send({ marks: fixedMarks() });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body).toMatchObject({ status: 'in_review', junior: { id: t.seed.a.rep.userId }, result: { status: 'measured', quality: { failed: [] } } });
    expect(edit.body.marksOriginal).not.toEqual(edit.body.marks);

    // Only a senior finalises, and only after the first review
    expect((await rep.post(`/api/window-scans/${id}/finalize`).send({ outcome: 'measured' })).status).toBe(403);
    expect((await owner1.post(`/api/window-scans/${id}/finalize`).send({ outcome: 'measured' })).status).toBe(409);

    const sub = await rep.post(`/api/window-scans/${id}/submit`).send({});
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body).toMatchObject({ status: 'junior_done', mayEdit: false });
    // The junior can no longer move marks; the senior can
    expect((await rep.patch(`/api/window-scans/${id}/marks`).send({ marks: fixedMarks() })).status).toBe(403);
    expect((await rep.post(`/api/window-scans/${id}/submit`).send({})).status).toBe(409);
    // While the homeowner still sees "being checked"
    expect(windowOf(await homeView(s)).scan?.state).toBe('checking');
    expect(windowOf(await homeView(s)).widthIn).toBe(40);

    const fin = await office.post(`/api/window-scans/${id}/finalize`).send({ outcome: 'measured' });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body).toMatchObject({ status: 'measured', outcome: 'measured', overrode: false, senior: { id: t.seed.a.office.userId }, mayFinalize: false });
    expect(fin.body.history.map((h: { action: string }) => h.action)).toEqual(['created', 'marks_edited', 'submitted', 'finalized']);
    const w = windowOf(await homeView(s));
    near(w.widthIn, 34.7, 0.1);
    near(w.heightIn, 55.8, 0.1);
    expect(w.quality).toBe('good');
    expect(w.scan).toMatchObject({ state: 'measured', label: 'Measured' });
    // Finished: nothing more can change
    expect((await owner1.patch(`/api/window-scans/${id}/marks`).send({ marks: fixedMarks() })).status).toBe(409);
    expect((await owner1.post(`/api/window-scans/${id}/expedite`).send({})).status).toBe(409);
    expect((await queue(rep, 'done')).scans).toHaveLength(1);
    expect((await queue(rep)).scans).toHaveLength(0);
    const audit = await q(`select action from audit_log where company_id = $1 and action like 'window_scan.%' order by at`, [t.seed.a.companyId]);
    expect(audit.map((a) => a.action)).toEqual(['window_scan.create', 'window_scan.marks', 'window_scan.submit', 'window_scan.finalize']);
  });

  test('measured with a gate failing needs a written reason (the senior overrides); without a size it cannot be measured at all', async () => {
    const { s } = await scanned('bad-mark');
    const id = await scanId();
    expect((await rep.post(`/api/window-scans/${id}/submit`).send({})).status).toBe(200);
    const blocked = await owner1.post(`/api/window-scans/${id}/finalize`).send({ outcome: 'measured' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe('gates_failed');
    expect((await owner1.post(`/api/window-scans/${id}/finalize`).send({ outcome: 'measured', override: true, reason: '' })).status).toBe(422);
    expect(windowOf(await homeView(s)).widthIn).toBe(40);
    const ok = await owner1.post(`/api/window-scans/${id}/finalize`).send({ outcome: 'measured', override: true, reason: 'Checked the close-up by eye; the mark is on the corner' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'measured', overrode: true, outcomeReason: expect.stringContaining('close-up') });
    near(windowOf(await homeView(s)).widthIn, 34.7, 0.1);
  });

  test('a scan with a corner on no frame has no size: it cannot be measured, only sent to a visit', async () => {
    await scanned('few-marks');
    const id = await scanId();
    const d = await detail(rep, id);
    // Take every mark off the bottom right corner
    const marks = d.marks.filter((m) => m.corner !== 2);
    const edit = await rep.patch(`/api/window-scans/${id}/marks`).send({ marks });
    expect(edit.status).toBe(200);
    expect(edit.body.result).toMatchObject({ cornersM: null, widthIn: null, heightIn: null });
    await rep.post(`/api/window-scans/${id}/submit`).send({});
    const res = await owner1.post(`/api/window-scans/${id}/finalize`).send({ outcome: 'measured', override: true, reason: 'I say so' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('no_size');
  });

  test('visit required needs a reason; the homeowner is told, and the window is marked to check', async () => {
    const { s } = await scanned('skewed-corner');
    const id = await scanId();
    await rep.post(`/api/window-scans/${id}/submit`).send({});
    const none = await owner1.post(`/api/window-scans/${id}/finalize`).send({ outcome: 'visit_required' });
    expect(none.status).toBe(422);
    expect(none.body.code).toBe('reason_needed');
    const ok = await owner1.post(`/api/window-scans/${id}/finalize`).send({ outcome: 'visit_required', reason: 'Bay window, the corners are not square' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'visit_required', outcome: 'visit_required', outcomeReason: 'Bay window, the corners are not square' });
    const w = windowOf(await homeView(s));
    expect(w.scan).toMatchObject({ state: 'visit_required' });
    expect(w.quality).toBe('check');
    expect(w.reasons).toEqual(['We will measure this one at your free visit.']);
    expect(w.widthIn).toBe(40);
  });

  test('marks and bodies are checked: a mark on a frame that is not there, unknown keys, a bad id', async () => {
    await scanned('bad-mark');
    const id = await scanId();
    expect((await rep.patch(`/api/window-scans/${id}/marks`).send({ marks: [{ frameId: 'zzz', corner: 0, x: 1, y: 1, source: 'user' }] })).status).toBe(400);
    expect((await rep.patch(`/api/window-scans/${id}/marks`).send({ marks: [{ frameId: 'r1', corner: 0, x: 99999, y: 1, source: 'user' }] })).status).toBe(400);
    expect((await rep.patch(`/api/window-scans/${id}/marks`).send({ marks: [], extra: 1 })).status).toBe(400);
    expect((await owner1.post(`/api/window-scans/${id}/finalize`).send({ outcome: 'maybe' })).status).toBe(400);
    expect((await rep.get('/api/window-scans/not-an-id')).status).toBe(404);
    // Nothing changed
    expect((await detail(rep, id)).status).toBe('needs_review');
  });

  test("one company never sees another's scans: not in the queue, not by id, not the pictures, not editable", async () => {
    await scanned('bad-mark');
    const id = await scanId();
    const bolt = await loginAs(t.app, t.seed.b.owner);
    expect((await queue(bolt)).scans).toHaveLength(0);
    expect((await queue(bolt)).counts.needs_review).toBe(0);
    expect((await bolt.get(`/api/window-scans/${id}`)).status).toBe(404);
    expect((await bolt.get(`/api/window-scans/${id}/frames/r1/image`)).status).toBe(404);
    expect((await bolt.patch(`/api/window-scans/${id}/marks`).send({ marks: [] })).status).toBe(404);
    expect((await bolt.post(`/api/window-scans/${id}/submit`).send({})).status).toBe(404);
    expect((await bolt.post(`/api/window-scans/${id}/finalize`).send({ outcome: 'visit_required', reason: 'x' })).status).toBe(404);
    expect((await bolt.post(`/api/window-scans/${id}/expedite`).send({})).status).toBe(404);
    // and a second company's request cannot take a scan for this company's window
    const other = await start(BOLT);
    const body = await scanBody(other, fixture('clean-34x55'), {}, BOLT);
    expect((await send('post', other, `/requests/${other.id}/scans`, body, BOLT)).status).toBe(409);
  });
});

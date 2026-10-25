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
  scanProject,
  type ScanResult,
  type SolarBuilding,
} from '@roofline/shared';
import { colmapAnswer, FakeColmap, FakeWindowSegmenter, type SegmentAnswer } from '../src/providers/fakes/scan-refine.ts';
import { seedFootprintFixture } from '../src/scripts/footprint-fixture.ts';
import { arCorners, boxCorners, greyJpeg } from './homeowner-fixture.ts';
import { loginAs, makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

/*
 * The server's refinement of a multi-frame window scan (docs/windows/scan-contract.md, "Refinement"): the `scan-refine` job
 * with a fake SAM 2 and a fake COLMAP, against a real database. A scan is stored as `processing`, the job refines it (AI marks
 * on every frame, COLMAP's poses when they line up with ARKit's, robust triangulation), then accepts it or sends it to a person;
 * a reviewer can run it again; and a refinement that cannot be done never strands a scan. Needs Docker.
 */

const NOW = new Date('2026-10-25T15:00:00.000Z');
const ACME = 'acme-refine';
const ADDRESS = '4810 Underwood Ave, Omaha, NE 68132';

let owner: pg.Pool;
let t: TestApp;
const q = async (text: string, values: unknown[] = []) => (await owner.query(text, values)).rows;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

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
  t = await makeTestApp({ TRUST_PROXY: 1, SCAN_REFINE: 'on' });
  t.clock.set(NOW);
  await q(
    `insert into company_settings (company_id, quote_enabled, quote_slug, quote_products) values ($1, true, $2, $3)
     on conflict (company_id) do update set quote_enabled = true, quote_slug = excluded.quote_slug, quote_products = excluded.quote_products`,
    [t.seed.a.companyId, ACME, ['windows', 'roof']],
  );
  await houseAt(ADDRESS);
});
afterEach(async () => {
  await t.close();
});

let ipCounter = 0;
const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;
const base = `/api/public/homeowner/${ACME}`;
type Started = { id: string; token: string };
function send(method: 'get' | 'post', s: Started | null, path: string, body?: unknown) {
  let req = request(t.app)[method](`${base}${path}`).set('X-Forwarded-For', nextIp());
  if (s !== null) req = req.set('Authorization', `Bearer ${s.token}`);
  return body === undefined ? req : req.send(body as object);
}
async function start(): Promise<Started> {
  const res = await send('post', null, '/requests', { address: ADDRESS, services: ['windows'] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const b = res.body as HomeownerCreated;
  return { id: b.requestId, token: b.token };
}
async function upload(s: Started): Promise<string> {
  const res = await request(t.app)
    .post(`${base}/requests/${s.id}/uploads`)
    .set('X-Forwarded-For', nextIp())
    .set('Authorization', `Bearer ${s.token}`)
    .set('Content-Type', 'image/jpeg')
    .send(Buffer.from(greyJpeg(1920, 1440)));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
}
async function addWindow(s: Started): Promise<void> {
  const photo = await upload(s);
  const res = await send('post', s, `/requests/${s.id}/windows`, {
    id: 'w1',
    room: 'Kitchen',
    label: 'Sink window',
    style: 'double-hung',
    scale: { kind: 'ar', pointsM: arCorners(40, 50), trackingLostCount: 0, device: 'arkit-lidar' },
    uploadId: photo,
    corners: boxCorners(1920, 1440),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

type Fixture = { input: { frames: ScanFrame[]; marks: ScanMark[]; wall: unknown }; expected: { status: 'measured' | 'needs_review'; widthIn: number | null; heightIn: number | null; cornersM: number[][] | null; quality: ScanResult['quality'] } };
const fixture = (name: string): Fixture => JSON.parse(readFileSync(new URL(`../../../packages/shared/test/fixtures/window-scan/${name}.json`, import.meta.url), 'utf8')) as Fixture;

type ScanBodyJson = Record<string, unknown> & { frames: ScanFrame[]; marks: ScanMark[] };
async function scanBody(s: Started, fx: Fixture, marks: ScanMark[] = fx.input.marks): Promise<ScanBodyJson> {
  const frames: ScanFrame[] = [];
  for (const f of fx.input.frames) frames.push({ ...f, uploadId: await upload(s) });
  const e = fx.expected;
  return {
    scanId: '5c0d7a52-1d3c-4a53-9d4e-0a6a5e0f1a01',
    windowId: 'w1',
    app: '0.1.0 (2610251200)',
    device: 'iPhone17,2',
    wall: fx.input.wall,
    frames,
    marks,
    result: { cornersM: e.cornersM, widthIn: e.widthIn, heightIn: e.heightIn, windowFrame: null, quality: e.quality, status: e.status },
  };
}

/** The window as a frame sees it, as the fake SAM answers it: the true corners in 0..1 of the picture; close-ups give nothing (the window runs off them). */
function truthAnswers(fx: Fixture, frames: ScanFrame[], over: (index: number, a: NonNullable<SegmentAnswer>) => SegmentAnswer = (_, a) => a): (call: { index: number }) => SegmentAnswer {
  return (call) => {
    const f = frames[call.index]!;
    if (f.kind === 'closeup') return null;
    const px = fx.expected.cornersM!.map((p) => scanProject(p as [number, number, number], f.cameraTransform, f.intrinsics)!);
    const corners = px.map((p) => [p[0] / f.intrinsics.width, p[1] / f.intrinsics.height]) as NonNullable<SegmentAnswer>['corners'];
    return over(call.index, { corners });
  };
}

const near = (a: number | null, b: number, tol: number) => expect(Math.abs((a ?? NaN) - b)).toBeLessThanOrEqual(tol);
const windowOf = async (s: Started): Promise<HomeownerRequestView['windows'][number]> => {
  const res = await send('get', s, `/requests/${s.id}`);
  return (res.body as HomeownerRequestView).windows.find((w) => w.id === 'w1')!;
};
const row = async () => (await q(`select * from window_scans`))[0]!;

/** A scan sent with a fake SAM that sees the true window and a fake COLMAP that agrees with ARKit. */
async function scanned(fxName: string, o: { marks?: (fx: Fixture) => ScanMark[]; sam?: (fx: Fixture, frames: ScanFrame[]) => FakeWindowSegmenter | null; colmap?: FakeColmap | null } = {}) {
  const fx = fixture(fxName);
  const s = await start();
  await addWindow(s);
  const body = await scanBody(s, fx, o.marks?.(fx));
  const sam = o.sam === undefined ? new FakeWindowSegmenter(truthAnswers(fx, body.frames)) : o.sam(fx, body.frames);
  if (sam !== null) t.deps.windowSegmenter = sam;
  t.deps.scanColmap = o.colmap === undefined ? new FakeColmap((job) => colmapAnswer(job)) : o.colmap;
  const res = await send('post', s, `/requests/${s.id}/scans`, body);
  return { s, fx, body, res, sam: sam as FakeWindowSegmenter };
}

describe('a scan with the refinement on', () => {
  test('is stored as processing: the phone gets the first result, the homeowner is told it is being checked, the window keeps its size, a job is queued', async () => {
    const { s, res } = await scanned('clean-34x55');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'processing', result: { status: 'measured', quality: { failed: [] } } });
    near(res.body.result.widthIn, 34.625, 0.0625);
    const w = await windowOf(s);
    expect(w.widthIn).toBe(40);
    expect(w.scan).toMatchObject({ state: 'checking', label: 'Being checked by WinChoice' });
    const r = await row();
    expect(r.status).toBe('processing');
    expect(r.refinement).toMatchObject({ state: 'queued', trigger: 'upload' });
    expect(t.jobs.sent.filter((j) => j.name === 'scan-refine')).toEqual([{ name: 'scan-refine', data: { companyId: t.seed.a.companyId, scanRowId: r.id }, singletonKey: r.id }]);
  });

  test('the job refines it: AI marks on every regular frame, COLMAP poses taken, accepted, and the window takes the size', async () => {
    const { s, sam, fx } = await scanned('clean-34x55');
    await t.jobs.drain(t.deps);
    expect(t.jobs.errors).toEqual([]);
    const r = await row();
    expect(r.status).toBe('measured');
    expect(r.refinement).toMatchObject({ state: 'done', poseSource: 'colmap', poseNote: null });
    expect(r.refinement.colmap).toMatchObject({ ran: true, used: true, registered: 9, total: 9, alignmentRmsCm: 0.4 });
    // SAM was asked on every frame, with the projected window as its box and its centre as the point
    expect(sam.calls).toHaveLength(9);
    for (const c of sam.calls) {
      expect(c.box.w).toBeGreaterThan(0);
      expect(c.aim.x).toBeGreaterThan(c.box.x);
      expect(c.aim.x).toBeLessThan(c.box.x + c.box.w);
    }
    const ai = r.refinement.frames as { frameId: string; state: string; marks: number; maskKey: string | null }[];
    expect(ai.filter((f) => f.state === 'ok')).toHaveLength(5);
    expect(ai.filter((f) => f.state === 'no_quad')).toHaveLength(4);
    expect(r.refinement.aiMarks).toHaveLength(20);
    // the effective result is the refined one; the first one is kept beside it
    expect(r.server_result.refined).toMatchObject({ poseSource: 'colmap', colmapFrames: 9, frames: 9, aiFrames: 5, aiMarks: 20, marksDropped: 0 });
    near(r.server_result.widthIn, fx.expected.widthIn!, 0.0625);
    expect(r.refinement.firstResult.refined).toBeUndefined();
    expect((r.history as { action: string }[]).map((h) => h.action)).toEqual(['created', 'refined', 'auto_accepted']);
    // the window took the scan's size
    const w = await windowOf(s);
    near(w.widthIn, 34.625, 0.0625);
    expect(w.scan).toMatchObject({ state: 'measured', label: 'Measured' });
    // a mask for each frame that had one
    for (const f of ai.filter((x) => x.maskKey !== null)) expect(await t.objectStore.get(f.maskKey!)).not.toBeNull();
  });

  test('phone marks that are off on two frames: the first result needs review, the AI saves the scan', async () => {
    const worse = (fx: Fixture) => fx.input.marks.map((m) => (m.frameId === 'r1' && m.corner === 0 ? { ...m, x: m.x + 22, y: m.y + 9 } : m.frameId === 'r4' && m.corner === 2 ? { ...m, x: m.x - 25 } : m));
    const { res } = await scanned('clean-34x55', { marks: worse });
    expect(res.body).toMatchObject({ status: 'processing', result: { status: 'needs_review' } });
    await t.jobs.drain(t.deps);
    const r = await row();
    expect(r.status).toBe('measured');
    expect(r.server_result.quality.failed).toEqual([]);
    expect(r.refinement.alternatives).toHaveLength(2);
    expect(r.refinement.firstResult.status).toBe('needs_review');
  });

  test('a scan that still fails a gate goes to review, with the refined poses and marks for the reviewer; the window keeps its size', async () => {
    const { s } = await scanned('skewed-corner', { sam: () => new FakeWindowSegmenter(() => null) });
    await t.jobs.drain(t.deps);
    const r = await row();
    expect(r.status).toBe('needs_review');
    expect(r.refinement).toMatchObject({ state: 'done', poseSource: 'colmap' });
    expect((await windowOf(s)).widthIn).toBe(40);
    expect((r.history as { action: string }[]).map((h) => h.action)).toEqual(['created', 'refined']);
  });
});

describe('COLMAP and the poses', () => {
  test('poses that do not line up with ARKit (3 cm) are not taken, and the reviewer is told why', async () => {
    await scanned('clean-34x55', { colmap: new FakeColmap((job) => colmapAnswer(job, { rmsCm: 3 })) });
    await t.jobs.drain(t.deps);
    const r = await row();
    expect(r.refinement).toMatchObject({ state: 'done', poseSource: 'arkit', poses: {} });
    expect(r.refinement.poseNote).toContain('3.0 cm');
    expect(r.refinement.colmap).toMatchObject({ ran: true, used: false });
    expect(r.status).toBe('measured');
  });

  test('fewer than four registered photos keep ARKit', async () => {
    await scanned('clean-34x55', { colmap: new FakeColmap((job) => colmapAnswer(job, { registered: ['r1', 'r2', 'r3'] })) });
    await t.jobs.drain(t.deps);
    const r = await row();
    expect(r.refinement).toMatchObject({ poseSource: 'arkit' });
    expect(r.refinement.poseNote).toContain('only 3 of 9');
  });

  test('COLMAP failing, or not being set up, leaves ARKit in place and the AI still runs', async () => {
    await scanned('clean-34x55', { colmap: new FakeColmap(() => ({ ok: false, reason: 'no_model', detail: 'COLMAP could not start a reconstruction.' })) });
    await t.jobs.drain(t.deps);
    expect((await row()).refinement).toMatchObject({ state: 'done', poseSource: 'arkit', poseNote: 'COLMAP could not start a reconstruction.' });
    expect((await row()).refinement.aiMarks).toHaveLength(20);
  });

  test('COLMAP throwing is the same: ARKit is kept', async () => {
    await scanned('clean-34x55', {
      colmap: new FakeColmap(() => {
        throw new Error('spawn python ENOENT');
      }),
    });
    await t.jobs.drain(t.deps);
    const r = await row();
    expect(r.refinement).toMatchObject({ state: 'done', poseSource: 'arkit' });
    expect(r.refinement.poseNote).toContain('could not be run');
    expect(r.status).toBe('measured');
  });

  test('the refined poses are the ones the reviewer’s screen and the server work with', async () => {
    // COLMAP's cameras are 2 mm off ARKit's: they replace them on every frame
    const moved = new FakeColmap((job) => colmapAnswer(job, { move: (_id, m) => m.map((v, i) => (i === 12 ? v + 0.002 : v)) }));
    await scanned('skewed-corner', { colmap: moved, sam: () => new FakeWindowSegmenter(() => null) });
    await t.jobs.drain(t.deps);
    const r = await row();
    expect(Object.keys(r.refinement.poses)).toHaveLength(9);
    const staff = await loginAs(t.app, t.seed.a.owner);
    const detail = (await staff.get(`/api/window-scans/${r.id}`)).body as ScanDetailView;
    const first = detail.frames[0]!;
    expect(first.poseSource).toBe('colmap');
    expect(first.cameraTransform[12]).toBeCloseTo((r.frames as ScanFrame[])[0]!.cameraTransform[12]! + 0.002, 9);
    expect(detail.refinement).toMatchObject({ state: 'done', poseSource: 'colmap', colmap: { used: true, registered: 9 } });
    expect(detail.refinement!.frames.every((f) => f.maskUrl === null || f.maskUrl.startsWith(`/api/window-scans/${r.id}/frames/`))).toBe(true);
    // saving marks works the result out with the refined poses (the same as the screen did)
    const res = await staff.patch(`/api/window-scans/${r.id}/marks`).send({ marks: detail.marks });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as ScanDetailView).result.refined?.poseSource).toBe('colmap');
  });
});

describe('when the refinement cannot be done', () => {
  test('a scan is not left processing: it takes the first result’s decision (a clean one is accepted)', async () => {
    const { s } = await scanned('clean-34x55');
    // the photos cannot be read from the store any more
    t.objectStore.get = async () => {
      throw new Error('store down');
    };
    await t.jobs.drain(t.deps);
    const r = await row();
    expect(r.status).toBe('measured');
    expect(r.refinement).toMatchObject({ state: 'failed', error: 'store down' });
    expect((r.history as { action: string }[]).map((h) => h.action)).toEqual(['created', 'refine_failed', 'auto_accepted']);
    near((await windowOf(s)).widthIn, 34.625, 0.0625);
  });

  test('a scan whose first result needed a person still goes to one', async () => {
    await scanned('skewed-corner');
    t.objectStore.get = async () => {
      throw new Error('store down');
    };
    await t.jobs.drain(t.deps);
    const r = await row();
    expect(r.status).toBe('needs_review');
    expect(r.refinement.state).toBe('failed');
  });

  test('the queue not taking the job: the scan falls back at once', async () => {
    t.jobs.send = async () => {
      throw new Error('queue down');
    };
    const { res } = await scanned('clean-34x55');
    expect(res.status).toBe(201);
    const r = await row();
    expect(r.status).toBe('measured');
    expect(r.refinement).toMatchObject({ state: 'failed', error: 'The refinement could not be queued.' });
  });

  test('a segmenter that falls over on every frame costs nothing: the frames say so and the phone’s marks stand', async () => {
    const sam = new FakeWindowSegmenter(() => null);
    sam.failWith = new Error('model crashed');
    await scanned('clean-34x55', { sam: () => sam });
    await t.jobs.drain(t.deps);
    const r = await row();
    expect(r.status).toBe('measured');
    expect(r.refinement).toMatchObject({ state: 'done' });
    expect((r.refinement.frames as { state: string }[]).every((f) => f.state === 'error')).toBe(true);
    expect(r.refinement.aiMarks).toEqual([]);
  });

  test('no segmenter and no COLMAP on the server: the refinement is off, and a scan is accepted at once as before', async () => {
    const fx = fixture('clean-34x55');
    const s = await start();
    await addWindow(s);
    t.deps.scanColmap = null;
    const res = await send('post', s, `/requests/${s.id}/scans`, await scanBody(s, fx));
    expect(res.body.status).toBe('measured');
    expect((await row()).refinement).toBeNull();
    expect(t.jobs.sent.filter((j) => j.name === 'scan-refine')).toEqual([]);
  });
});

describe('staff: refine again', () => {
  let staff: SuperAgent;
  beforeEach(async () => {
    staff = await loginAs(t.app, t.seed.a.owner);
  });

  async function inReview() {
    // A skewed corner (not a bad mark): no refinement can make it pass, so it stays with a person
    const out = await scanned('skewed-corner', { sam: () => new FakeWindowSegmenter(() => null) });
    await t.jobs.drain(t.deps);
    const r = await row();
    expect(r.status).toBe('needs_review');
    return { ...out, id: r.id as string };
  }

  test('queues the job, keeps the status, keeps what the reviewer placed, and the new result replaces the old', async () => {
    const { id, fx } = await inReview();
    // the reviewer moves a mark: it is theirs (source 'user')
    const detail0 = (await staff.get(`/api/window-scans/${id}`)).body as ScanDetailView;
    expect(detail0.mayRefine).toBe(true);
    const mine = detail0.marks.map((m) => (m.frameId === 'r3' && m.corner === 1 ? { ...m, x: m.x + 1.5 } : m));
    const saved = (await staff.patch(`/api/window-scans/${id}/marks`).send({ marks: mine.map((m) => (m.frameId === 'r3' && m.corner === 1 ? { ...m, source: 'user' } : m)) })).body as ScanDetailView;
    expect(saved.status).toBe('in_review');
    t.jobs.sent.length = 0;
    const res = await staff.post(`/api/window-scans/${id}/refine`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as ScanDetailView).refinement).toMatchObject({ state: 'queued', trigger: 'rerun' });
    expect((res.body as ScanDetailView).mayRefine).toBe(false);
    expect(t.jobs.sent.filter((j) => j.name === 'scan-refine')).toHaveLength(1);
    // asking twice while it waits is refused
    expect((await staff.post(`/api/window-scans/${id}/refine`).send({})).body.code).toBe('already_running');
    await t.jobs.drain(t.deps);
    const after = (await staff.get(`/api/window-scans/${id}`)).body as ScanDetailView;
    expect(after.status).toBe('in_review');
    expect(after.refinement).toMatchObject({ state: 'done', trigger: 'rerun' });
    expect(after.marks.find((m) => m.frameId === 'r3' && m.corner === 1)).toMatchObject({ source: 'user', x: mine.find((m) => m.frameId === 'r3' && m.corner === 1)!.x });
    expect(after.result.refined).toBeDefined();
    near(after.result.widthIn, fx.expected.widthIn ?? 34.6, 3);
  });

  test('is refused for a finished scan, for a company that is not the scan’s, and when the server has nothing to refine with', async () => {
    const { id } = await inReview();
    // measured: finished
    await q(`update window_scans set status = 'measured', outcome = 'measured' where id = $1`, [id]);
    const closed = await staff.post(`/api/window-scans/${id}/refine`).send({});
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('scan_closed');
    await q(`update window_scans set status = 'needs_review', outcome = null where id = $1`, [id]);
    const other = await loginAs(t.app, t.seed.b.owner);
    expect((await other.post(`/api/window-scans/${id}/refine`).send({})).status).toBe(404);
    t.deps.scanColmap = null;
    t.deps.windowSegmenter = new FakeWindowSegmenter(() => null);
    (t.deps.windowSegmenter as FakeWindowSegmenter).configured = false;
    const off = await staff.post(`/api/window-scans/${id}/refine`).send({});
    expect(off.status).toBe(503);
    expect(off.body.code).toBe('refine_unavailable');
    expect(((await staff.get(`/api/window-scans/${id}`)).body as ScanDetailView).mayRefine).toBe(false);
  });

  test('the mask and the point cloud are served from the scan’s own record, behind the session', async () => {
    const fx = fixture('clean-34x55');
    const s = await start();
    await addWindow(s);
    const body = await scanBody(s, fx);
    t.deps.windowSegmenter = new FakeWindowSegmenter(truthAnswers(fx, body.frames));
    t.deps.scanColmap = new FakeColmap(async (job) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(job.plyPath, 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 1 -3\n');
      const out = colmapAnswer(job);
      return out.ok ? { ...out, points: { count: 1, ply: job.plyPath } } : out;
    });
    await send('post', s, `/requests/${s.id}/scans`, { ...body });
    await t.jobs.drain(t.deps);
    const r = await row();
    const detail = (await staff.get(`/api/window-scans/${r.id}`)).body as ScanDetailView;
    const withMask = detail.frames.find((f) => f.ai?.maskUrl)!;
    const mask = await staff.get(withMask.ai!.maskUrl!);
    expect(mask.status).toBe(200);
    expect(mask.headers['content-type']).toBe('image/png');
    expect(Buffer.from(mask.body).subarray(1, 4).toString()).toBe('PNG');
    expect(detail.refinement!.cloudUrl).toBe(`/api/window-scans/${r.id}/refinement/cloud`);
    const cloud = await staff.get(detail.refinement!.cloudUrl!);
    expect(cloud.status).toBe(200);
    expect(cloud.body).toEqual({ count: 1, points: [[0, 1, -3, 150, 150, 150]] });
    const ply = await staff.get(`${detail.refinement!.cloudUrl!}.ply`);
    expect(ply.status).toBe(200);
    expect(ply.text).toContain('end_header');
    // other companies and made-up frames get nothing
    expect((await staff.get(`/api/window-scans/${r.id}/frames/nope/mask`)).status).toBe(404);
    expect((await (await loginAs(t.app, t.seed.b.owner)).get(withMask.ai!.maskUrl!)).status).toBe(404);
  });
});

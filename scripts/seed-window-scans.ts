import { Client } from 'pg';
import jpeg from 'jpeg-js';
import { computeScanResult, scanMat4Rotate, scanProject, type ScanFrame, type ScanVec3 } from '../packages/shared/src/window-scan.ts';
import { buildScene, type Scene, type SceneOptions, SCENE_INTRINSICS } from '../packages/shared/test/fixtures/window-scan-scene.ts';

/*
 * Seeds a running demo (`npm run demo`) with multi-frame window scans for the staff review screens: homeowner requests for
 * the WinChoice demo company, each with a window and a scan of synthetic frames (a siding wall and a white window drawn
 * with the same camera model the server triangulates with, so the marks sit on the corners). It goes through the real
 * public API and the real staff API, so it exercises them too.
 *
 *   DEMO_PORT=4710 DEMO_DB_PORT=54710 npx tsx scripts/seed-window-scans.ts          (the app's port; the database's port, for the SLA dates)
 *   --again   seed even when scans exist already
 *
 * Seeded: five scans that need a person (one expedited, one overdue, one with a junior reviewer working on it, one waiting
 * for the senior reviewer), a scan accepted at once, and one sent to a visit.
 */

const PORT = Number(process.env.DEMO_PORT?.trim() || 4500);
const DB_PORT = Number(process.env.DEMO_DB_PORT?.trim() || 54339);
const BASE = `http://127.0.0.1:${PORT}`;
const SLUG = process.env.DEMO_SLUG?.trim() || 'winchoice';
const LOGIN = { email: process.env.DEMO_EMAIL?.trim() || 'owner@winchoice.test', password: process.env.DEMO_PASSWORD?.trim() || 'winchoice-demo' };
const AGAIN = process.argv.includes('--again');

const log = (line: string) => process.stdout.write(`[seed-scans] ${line}\n`);

/* -- a tiny renderer: the wall and the window as the camera sees them -------------------------------------------------- */

const IMG_W = 960;
const IMG_H = 720;

type Rgb = [number, number, number];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** (u, v) in the unit square for a point in a quad (TL, TR, BR, BL) by Newton iterations on the bilinear map; null when it is outside. */
function quadUv(q: [number, number][], x: number, y: number): [number, number] | null {
  const [p0, p1, p2, p3] = q as [[number, number], [number, number], [number, number], [number, number]];
  let u = 0.5;
  let v = 0.5;
  for (let i = 0; i < 6; i++) {
    const fx = (1 - u) * (1 - v) * p0[0] + u * (1 - v) * p1[0] + u * v * p2[0] + (1 - u) * v * p3[0] - x;
    const fy = (1 - u) * (1 - v) * p0[1] + u * (1 - v) * p1[1] + u * v * p2[1] + (1 - u) * v * p3[1] - y;
    const dxu = -(1 - v) * p0[0] + (1 - v) * p1[0] + v * p2[0] - v * p3[0];
    const dxv = -(1 - u) * p0[0] - u * p1[0] + u * p2[0] + (1 - u) * p3[0];
    const dyu = -(1 - v) * p0[1] + (1 - v) * p1[1] + v * p2[1] - v * p3[1];
    const dyv = -(1 - u) * p0[1] - u * p1[1] + u * p2[1] + (1 - u) * p3[1];
    const det = dxu * dyv - dxv * dyu;
    if (Math.abs(det) < 1e-12) return null;
    u -= (fx * dyv - fy * dxv) / det;
    v -= (fy * dxu - fx * dyu) / det;
  }
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? [u, v] : null;
}

function renderFrame(scene: Scene, frame: ScanFrame, wallZ: number, sizeM: { w: number; h: number }): Uint8Array {
  const data = new Uint8Array(IMG_W * IMG_H * 4);
  const k = frame.intrinsics;
  const sx = k.width / IMG_W;
  const sy = k.height / IMG_H;
  const eye: ScanVec3 = [frame.cameraTransform[12]!, frame.cameraTransform[13]!, frame.cameraTransform[14]!];
  const quad = scene.actualM.map((p) => [p[0], p[1]] as [number, number]);
  for (let py = 0; py < IMG_H; py++) {
    for (let px = 0; px < IMG_W; px++) {
      // the ray through this pixel, met with the wall plane z = wallZ
      const d = scanMat4Rotate(frame.cameraTransform, [((px + 0.5) * sx - k.cx) / k.fx, -((py + 0.5) * sy - k.cy) / k.fy, -1]);
      const t = (wallZ - eye[2]) / d[2];
      const X = eye[0] + d[0] * t;
      const Y = eye[1] + d[1] * t;
      let c: Rgb;
      const uv = t > 0 ? quadUv(quad, X, Y) : null;
      if (uv !== null) {
        const [u, v] = uv;
        const band = 0.05 / sizeM.w;
        const bandV = 0.05 / sizeM.h;
        const inGlass = u > band && u < 1 - band && v > bandV && v < 1 - bandV;
        if (!inGlass) {
          c = [243, 241, 236];
        } else if (Math.abs(v - 0.5) < 0.012) {
          c = [236, 234, 228]; // the meeting rail of a double-hung
        } else {
          // sky through the glass, with a soft diagonal reflection
          const sky = mix([150, 190, 226], [214, 232, 246], 1 - v);
          const streak = Math.max(0, 1 - Math.abs(u + v * 0.6 - 0.75) * 7) * 0.22;
          c = mix(sky, [255, 255, 255], streak);
          if (v > 0.5) c = mix(c, [120, 160, 130], 0.18);
        }
        // a thin shadow line inside the frame
        const edge = Math.min(u, 1 - u, v, 1 - v);
        if (edge < 0.004) c = mix(c, [60, 60, 60], 0.45);
      } else {
        // siding boards 0.2 m tall, each a little different, with a dark seam
        const board = Math.floor(Y / 0.2);
        const within = Y / 0.2 - board;
        const tone = 0.93 + 0.05 * Math.sin(board * 12.9898);
        c = [196 * tone, 186 * tone, 168 * tone];
        if (within < 0.07) c = mix(c, [110, 100, 88], 0.55);
        // grain
        const grain = Math.sin(X * 60 + board * 3.1) * 2.5;
        c = [c[0] + grain, c[1] + grain, c[2] + grain];
      }
      const i = (py * IMG_W + px) * 4;
      data[i] = Math.max(0, Math.min(255, c[0]));
      data[i + 1] = Math.max(0, Math.min(255, c[1]));
      data[i + 2] = Math.max(0, Math.min(255, c[2]));
      data[i + 3] = 255;
    }
  }
  return new Uint8Array(jpeg.encode({ width: IMG_W, height: IMG_H, data }, 78).data);
}

/* -- the public and staff APIs ------------------------------------------------------------------------------------------ */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- the API's answers, read loosely

async function call(method: string, path: string, o: { body?: unknown; token?: string; cookie?: string; raw?: Uint8Array } = {}): Promise<{ status: number; body: Json; cookie?: string }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.Cookie = o.cookie;
  let body: string | Buffer | undefined;
  if (o.raw) {
    headers['Content-Type'] = 'image/jpeg';
    body = Buffer.from(o.raw);
  } else if (o.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(o.body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body });
  const text = await res.text();
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Json), cookie: setCookie.map((c) => c.split(';')[0]).join('; ') || undefined };
}

function must<T extends { status: number; body: Json }>(r: T, ok: number[], what: string): T {
  if (!ok.includes(r.status)) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}

type Plan = {
  room: string;
  label: string;
  scene: SceneOptions;
  /** The staff side: leave it, or take it to in_review (a junior moved a mark), junior_done, or finish it. */
  stage: 'open' | 'in_review' | 'junior_done' | 'visit_required';
  expedite?: boolean;
  overdueHours?: number;
  homeowner?: { first: string; last: string; phone: string; email: string };
  address: string;
};

const PLANS: Plan[] = [
  {
    room: 'Kitchen',
    label: 'Sink window',
    address: '4810 Underwood Ave, Omaha, NE 68132',
    scene: { widthIn: 34.625, heightIn: 55.75, noisePx: 1, seed: 4, nudges: [['r2', 1, 12, -9]] },
    stage: 'open',
    expedite: true,
    homeowner: { first: 'Dana', last: 'Whitfield', phone: '(402) 555-0142', email: 'dana.w@example.com' },
  },
  {
    room: 'Living room',
    label: 'Front window',
    address: '1722 Pine Ridge Dr, Omaha, NE 68144',
    scene: { widthIn: 47.5, heightIn: 59.25, noisePx: 1, seed: 2, closeups: [], regular: [[-1.5, 1.2, 0], [1.5, 1.25, 0], [0, 1.3, 0.1]], drop: ['r3:0', 'r3:1', 'r3:2', 'r3:3'] },
    stage: 'open',
    overdueHours: 3,
    homeowner: { first: 'Marcus', last: 'Lee', phone: '(402) 555-0177', email: 'marcus.lee@example.com' },
  },
  {
    room: 'Bedroom 1',
    label: 'Street side',
    address: '905 Meadow Ln, Omaha, NE 68137',
    scene: { widthIn: 28, heightIn: 52, noisePx: 0.5, seed: 6, cornerOffsets: { 2: [0, -0.05, 0] } },
    stage: 'in_review',
    homeowner: { first: 'Priya', last: 'Raman', phone: '(402) 555-0108', email: 'priya.r@example.com' },
  },
  {
    room: 'Bedroom 2',
    label: 'Corner window',
    address: '3320 Oak Hollow Rd, Omaha, NE 68124',
    scene: { widthIn: 36, heightIn: 48, noisePx: 0.8, seed: 10, wall: { point: [0, 1.4, -2.55], normal: [0, 0, 1] } },
    stage: 'open',
  },
  {
    room: 'Den',
    label: 'Window A',
    address: '2614 Harbor View Ct, Omaha, NE 68135',
    scene: { widthIn: 30, heightIn: 60, noisePx: 1, seed: 8, nudges: [['r4', 0, -10, 8]] },
    stage: 'junior_done',
    homeowner: { first: 'Tom', last: 'Okafor', phone: '(402) 555-0191', email: 'tom.okafor@example.com' },
  },
  {
    room: 'Bathroom',
    label: 'Frosted window',
    address: '618 Cedar Bluff Way, Omaha, NE 68130',
    scene: { widthIn: 24, heightIn: 36, noisePx: 1, seed: 12 },
    stage: 'open',
  },
  {
    room: 'Dining room',
    label: 'Bay',
    address: '7701 Lakeshore Blvd, Omaha, NE 68112',
    scene: { widthIn: 60, heightIn: 48, noisePx: 0.5, seed: 14, cornerOffsets: { 1: [0.045, 0.03, 0.02], 2: [-0.03, 0, -0.02] } },
    stage: 'visit_required',
  },
];

const uuid = (n: number) => `5eed0000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** Waits for a scan the server is refining; null when it is not (the refinement is off). */
async function waitForRefinement(staff: (method: string, path: string) => Promise<{ status: number; body: Json }>): Promise<{ status: string; ms: number; line: string } | null> {
  const t0 = Date.now();
  let seenRefinement = false;
  for (;;) {
    const d = must(await staff('GET', ''), [200], 'detail').body;
    if (d.refinement) seenRefinement = true;
    if (d.status !== 'processing') {
      if (!seenRefinement) return null;
      const r = d.refinement as { poseSource: string | null; frames: { state: string }[]; timings: { aiMs: number; colmapMs: number } | null; colmap: { registered: number; total: number; alignmentRmsCm: number | null } | null };
      const ok = r.frames.filter((f) => f.state === 'ok').length;
      const line = `${r.poseSource ?? 'no'} poses${r.colmap ? ` ${r.colmap.registered}/${r.colmap.total} frames ${r.colmap.alignmentRmsCm ?? '-'} cm` : ''}, AI ${ok}/${r.frames.length} frames${r.timings ? `, AI ${(r.timings.aiMs / 1000).toFixed(1)} s, COLMAP ${(r.timings.colmapMs / 1000).toFixed(1)} s` : ''}`;
      return { status: d.status as string, ms: Date.now() - t0, line };
    }
    if (Date.now() - t0 > 600_000) throw new Error('the scan is still processing after 10 minutes');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function main(): Promise<void> {
  const login = must(await call('POST', '/api/auth/login', { body: LOGIN }), [200], 'sign in');
  const cookie = login.cookie!;
  const existing = must(await call('GET', '/api/window-scans?status=all', { cookie }), [200], 'queue');
  if ((existing.body.scans as unknown[]).length > 0 && !AGAIN) {
    log(`${(existing.body.scans as unknown[]).length} scans exist already; nothing seeded (--again seeds more).`);
    return;
  }
  const company = must(await call('GET', `/api/public/homeowner/${SLUG}/company`), [200], 'company');
  const db = new Client({ connectionString: `postgres://roofline:roofline@127.0.0.1:${DB_PORT}/roofline` });
  await db.connect();
  try {
    for (const [index, plan] of PLANS.entries()) {
      const scene = buildScene(plan.scene);
      const wallZ = plan.scene.wallZ ?? -3;
      const sizeM = { w: (plan.scene.widthIn ?? 34.625) * 0.0254, h: (plan.scene.heightIn ?? 55.75) * 0.0254 };
      const created = must(await call('POST', `/api/public/homeowner/${SLUG}/requests`, { body: { address: plan.address, services: ['windows'] } }), [201], 'request');
      const { requestId, token } = created.body as { requestId: string; token: string };
      const upload = async (bytes: Uint8Array) => (must(await call('POST', `/api/public/homeowner/${SLUG}/requests/${requestId}/uploads`, { token, raw: bytes }), [201], 'upload').body as { id: string }).id;

      // The frames, drawn and uploaded
      const frames: ScanFrame[] = [];
      for (const f of scene.frames) {
        const bytes = renderFrame(scene, f, wallZ, sizeM);
        frames.push({ ...f, uploadId: await upload(bytes), imageWidth: IMG_W, imageHeight: IMG_H });
      }
      // The window the phone sent first: one photo, an AR size a little off
      // (the photo is drawn at half the native size)
      const photoCorners = scene.truth.cornersM.map((p) => scanProject(p, frames[0]!.cameraTransform, SCENE_INTRINSICS)!.map((v) => v / 2));
      const windowId = `win-${index + 1}`;
      const arW = sizeM.w + 0.03;
      const arH = sizeM.h - 0.02;
      must(
        await call('POST', `/api/public/homeowner/${SLUG}/requests/${requestId}/windows`, {
          token,
          body: {
            id: windowId,
            room: plan.room,
            label: plan.label,
            style: 'double-hung',
            scale: { kind: 'ar', pointsM: [[0, 1.5, -2], [arW, 1.5, -2], [arW, 1.5 - arH, -2], [0, 1.5 - arH, -2]], trackingLostCount: 0, device: 'arkit-lidar' },
            uploadId: frames[0]!.uploadId,
            corners: photoCorners,
          },
        }),
        [201],
        'window',
      );
      // The scan, as the phone would send it (its own result from the same math)
      const comp = computeScanResult(frames, scene.marks, scene.wall);
      const scanId = uuid(index + 1);
      const sent = must(
        await call('POST', `/api/public/homeowner/${SLUG}/requests/${requestId}/scans`, {
          token,
          body: {
            scanId,
            windowId,
            app: '0.1.0 (2610251200)',
            device: 'iPhone17,2',
            wall: scene.wall,
            frames,
            marks: scene.marks,
            result: { cornersM: comp.cornersM, widthIn: comp.widthIn, heightIn: comp.heightIn, windowFrame: null, quality: comp.quality, status: comp.status },
          },
        }),
        [201],
        'scan',
      );
      if (plan.homeowner) {
        must(
          await call('POST', `/api/public/homeowner/${SLUG}/requests/${requestId}/contact`, {
            token,
            body: { firstName: plan.homeowner.first, lastName: plan.homeowner.last, phone: plan.homeowner.phone, email: plan.homeowner.email, zip: '68132', contactConsent: true, textConsent: false, consentVersion: company.body.consent.version },
          }),
          [200, 201],
          'contact',
        );
      }
      const [{ id }] = (await db.query('select id from window_scans where scan_id = $1', [scanId])).rows as [{ id: string }];
      const staff = (method: string, path: string, body?: unknown) => call(method, `/api/window-scans/${id}${path}`, { cookie, body });
      // With the server's refinement on (SCAN_REFINE=on) the scan waits as `processing` until the worker is done with it
      const waited = await waitForRefinement(staff);
      if (waited !== null) log(`${plan.room} · ${plan.label}: refined in ${(waited.ms / 1000).toFixed(1)} s -> ${waited.status}${waited.line ? ` (${waited.line})` : ''}`);
      if (waited !== null && !['needs_review', 'in_review'].includes(waited.status)) {
        log(`${plan.room} · ${plan.label}: the refinement decided it (${waited.status}); the "${plan.stage}" stage is skipped.`);
        continue;
      }
      if (plan.expedite) must(await staff('POST', '/expedite', {}), [200], 'expedite');
      if (plan.stage === 'in_review') {
        // A junior reviewer nudged a mark: the scan is theirs now
        const d = must(await staff('GET', ''), [200], 'detail').body;
        must(await staff('PATCH', '/marks', { marks: d.marks }), [200], 'marks');
      }
      if (plan.stage === 'junior_done') must(await staff('POST', '/submit', {}), [200], 'submit');
      if (plan.stage === 'visit_required') {
        must(await staff('POST', '/submit', {}), [200], 'submit');
        must(await staff('POST', '/finalize', { outcome: 'visit_required', reason: 'Bay window, the corners are not square. Measure at the visit.' }), [200], 'finalize');
      }
      if (plan.overdueHours) await db.query(`update window_scans set sla_due_at = now() - make_interval(hours => $2) where id = $1`, [id, plan.overdueHours]);
      log(`${plan.room} · ${plan.label}: ${sent.body.status}${comp.quality.failed.length ? ` (${comp.quality.failed.join(', ')})` : ''} -> ${plan.stage}`);
    }
  } finally {
    await db.end();
  }
  const final = must(await call('GET', '/api/window-scans?status=all', { cookie }), [200], 'queue');
  log(`Done: ${JSON.stringify(final.body.counts)}. Sign in as ${LOGIN.email} and open ${BASE}/scans`);
}

await main();

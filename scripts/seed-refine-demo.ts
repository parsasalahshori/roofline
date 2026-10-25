import { readFileSync } from 'node:fs';
import path from 'node:path';
import { computeScanResult, scanProject, type ScanFrame, type ScanMark, type ScanWall } from '../packages/shared/src/window-scan.ts';

/*
 * Seeds a running demo (`npm run demo` with SCAN_REFINE=on) with textured scans for the server's refinement: the photos are
 * drawn by apps/worker/python/synthetic_scene.py (a brick wall with a recessed window, real texture for COLMAP and SAM 2).
 *
 *   python apps/worker/python/synthetic_scene.py --out /tmp/brick-clean
 *   python apps/worker/python/synthetic_scene.py --out /tmp/brick-skew --skew 0.06 --seed 11
 *   DEMO_PORT=4720 npx tsx scripts/seed-refine-demo.ts /tmp/brick-clean "Garage" "Side window" /tmp/brick-skew "Porch" "Bay corner"
 *
 * Arguments come in threes: the scene directory, the room, the window's label. Each becomes a homeowner request with a window and a
 * scan, sent through the real public API; the worker then refines it.
 */

const PORT = Number(process.env.DEMO_PORT?.trim() || 4500);
const BASE = `http://127.0.0.1:${PORT}`;
const SLUG = process.env.DEMO_SLUG?.trim() || 'winchoice';
/** Where the scan numbers start (a second run with other scenes uses a higher one). */
const FIRST = Number(process.env.SEED_FIRST?.trim() || 1);
const log = (line: string) => process.stdout.write(`[seed-refine] ${line}\n`);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- the API's answers, read loosely

async function call(method: string, p: string, o: { body?: unknown; token?: string; raw?: Uint8Array } = {}): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  let body: string | Buffer | undefined;
  if (o.raw) {
    headers['Content-Type'] = 'image/jpeg';
    body = Buffer.from(o.raw);
  } else if (o.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(o.body);
  }
  const res = await fetch(`${BASE}${p}`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Json) };
}

function must<T extends { status: number; body: Json }>(r: T, ok: number[], what: string): T {
  if (!ok.includes(r.status)) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}

type Scene = { frames: (ScanFrame & { path: string })[]; marks: ScanMark[]; wall: ScanWall; truth: { cornersM: [number, number, number][]; widthIn: number; heightIn: number } };

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.length % 3 !== 0) throw new Error('Usage: seed-refine-demo.ts <scene dir> <room> <label> [...]');
  for (let i = 0; i < args.length; i += 3) {
    const [dir, room, label] = [args[i]!, args[i + 1]!, args[i + 2]!];
    const scene = JSON.parse(readFileSync(path.join(dir, 'scene.json'), 'utf8')) as Scene;
    const created = must(await call('POST', `/api/public/homeowner/${SLUG}/requests`, { body: { address: `${100 + i} Brick Row, Omaha, NE 68132`, services: ['windows'] } }), [201], 'request');
    const { requestId, token } = created.body as { requestId: string; token: string };
    const upload = async (bytes: Uint8Array) => (must(await call('POST', `/api/public/homeowner/${SLUG}/requests/${requestId}/uploads`, { token, raw: bytes }), [201], 'upload').body as { id: string }).id;
    const frames: ScanFrame[] = [];
    for (const f of scene.frames) {
      const { path: file, ...rest } = f;
      frames.push({ ...rest, uploadId: await upload(new Uint8Array(readFileSync(path.join(dir, file)))) });
    }
    const n = FIRST + i / 3;
    const windowId = `win-r${n}`;
    const photoCorners = scene.truth.cornersM.map((p) => scanProject(p, frames[0]!.cameraTransform, frames[0]!.intrinsics)!.map((v) => v / 2));
    must(
      await call('POST', `/api/public/homeowner/${SLUG}/requests/${requestId}/windows`, {
        token,
        body: { id: windowId, room, label, style: 'double-hung', scale: { kind: 'ar', pointsM: [[0, 1.5, -2], [0.9, 1.5, -2], [0.9, 0.1, -2], [0, 0.1, -2]], trackingLostCount: 0, device: 'arkit-lidar' }, uploadId: frames[0]!.uploadId, corners: photoCorners },
      }),
      [201],
      'window',
    );
    // The phone's marks: the regular frames' from the phone's own detection ('ai'), the close-ups snapped
    const marks = scene.marks.map((m) => ({ ...m, source: frames.find((f) => f.frameId === m.frameId)?.kind === 'closeup' ? ('snap' as const) : ('ai' as const) }));
    const comp = computeScanResult(frames, marks, scene.wall);
    const sent = must(
      await call('POST', `/api/public/homeowner/${SLUG}/requests/${requestId}/scans`, {
        token,
        body: {
          scanId: `5eed0001-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
          windowId,
          app: '0.1.0 (2610251200)',
          device: 'iPhone17,2',
          wall: scene.wall,
          frames,
          marks,
          result: { cornersM: comp.cornersM, widthIn: comp.widthIn, heightIn: comp.heightIn, windowFrame: null, quality: comp.quality, status: comp.status },
        },
      }),
      [201],
      'scan',
    );
    log(`${room} · ${label}: sent, the server says ${sent.body.status} (the phone's own marks give ${comp.status}${comp.quality.failed.length ? `: ${comp.quality.failed.join(', ')}` : ''})`);
  }
}

await main();

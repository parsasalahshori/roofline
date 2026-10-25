import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import type { ScanFrame, ScanResult } from '../packages/shared/src/window-scan.ts';
import { DirObjectStore } from '../apps/api/src/providers/fakes/dir-object-store.ts';
import { NoDetector, OwlV2Detector } from '../apps/api/src/providers/window-detector.ts';
import { Sam2Segmenter } from '../apps/api/src/providers/window-segmenter.ts';
import { runAiFrames } from '../apps/api/src/scans/refine/ai.ts';
import { COLMAP_SCRIPT, PythonColmapRunner } from '../apps/api/src/scans/refine/colmap.ts';

/*
 * Times the refinement's two halves on the scans of a running demo (read-only: nothing is written to the database or the store),
 * one after the other so neither slows the other: SAM 2 on every frame (each frame's time) and COLMAP on the photos.
 *
 *   DEMO_DB_PORT=54720 DEMO_COMPOSE_PROJECT=roofline-refine WINDOW_MODEL_DIR=~/RooflineWork/models \
 *   SCAN_COLMAP_PYTHON=~/RooflineWork/colmap-venv/bin/python npx tsx scripts/scan-refine-bench.ts [first-scan-count] [window label]
 *
 * With BENCH_NO_ESTIMATE=1 the AI starts from OWLv2 (the way it does on a scan with no window estimate yet) instead of the projected window.
 */

const DB_PORT = Number(process.env.DEMO_DB_PORT?.trim() || 54339);
const PROJECT = process.env.DEMO_COMPOSE_PROJECT?.trim() || 'roofline-demo';
const MODEL_DIR = process.env.WINDOW_MODEL_DIR?.trim();
const PYTHON = process.env.SCAN_COLMAP_PYTHON?.trim();
const LIMIT = Number(process.argv[2] ?? 100);
const ONLY = process.argv[3];
const NO_ESTIMATE = process.env.BENCH_NO_ESTIMATE === '1';

async function main(): Promise<void> {
  if (!MODEL_DIR || !PYTHON) throw new Error('Set WINDOW_MODEL_DIR and SCAN_COLMAP_PYTHON.');
  const db = new Client({ connectionString: `postgres://roofline:roofline@127.0.0.1:${DB_PORT}/roofline` });
  await db.connect();
  const store = new DirObjectStore(path.join(process.cwd(), '.demo-files', PROJECT));
  const sam = new Sam2Segmenter({ modelDir: MODEL_DIR });
  const colmap = new PythonColmapRunner({ python: PYTHON, script: COLMAP_SCRIPT, timeoutMs: 600_000 });
  const t0 = Date.now();
  await sam.warm();
  console.log(`SAM 2 model loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const rows = (
    await db.query(
      `select s.id, s.company_id, s.frames, s.server_result, r.window_measurement_id, w.uploads, (select label from jsonb_to_recordset(w.adjustments->'photoWindows') as x(id text, label text, room text) where x.id = s.window_id limit 1) as label
         from window_scans s join homeowner_requests r on r.id = s.homeowner_request_id join window_measurements w on w.id = r.window_measurement_id order by s.created_at limit $1`,
      [LIMIT],
    )
  ).rows as { id: string; company_id: string; frames: ScanFrame[]; server_result: ScanResult; uploads: { id: string; key: string }[]; label: string | null }[];
  for (const row of rows) {
    if (ONLY !== undefined && row.label !== ONLY) continue;
    const jpegs = new Map<string, Uint8Array | null>();
    for (const f of row.frames) {
      const up = row.uploads.find((u) => u.id === f.uploadId);
      jpegs.set(f.frameId, up ? await store.get(up.key) : null);
    }
    const a0 = Date.now();
    const ai = await runAiFrames(
      row.frames.map((frame) => ({ frame, jpeg: jpegs.get(frame.frameId) ?? null })),
      { segmenter: sam, detector: NO_ESTIMATE ? new OwlV2Detector({ modelDir: MODEL_DIR }) : new NoDetector(), estimateM: NO_ESTIMATE ? null : row.server_result.cornersM, maskKey: (id) => id },
    );
    const aiMs = Date.now() - a0;
    if (NO_ESTIMATE) {
      console.log(`${row.label}: OWLv2 + SAM 2 on every frame (${(aiMs / 1000).toFixed(1)} s): ${ai.frames.map((f) => `${f.frameId} ${f.state}${f.prompt ? '/' + f.prompt : ''}`).join(', ')}`);
      continue;
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-'));
    await mkdir(path.join(dir, 'images'));
    const images = [];
    for (const f of row.frames) {
      const file = path.join(dir, 'images', `${f.frameId}.jpg`);
      await writeFile(file, jpegs.get(f.frameId)!);
      images.push({ frameId: f.frameId, path: file, imageWidth: f.imageWidth, imageHeight: f.imageHeight, intrinsics: f.intrinsics, cameraTransform: f.cameraTransform });
    }
    const c0 = Date.now();
    const out = await colmap.run({ images, workDir: path.join(dir, 'run'), plyPath: path.join(dir, 'cloud.ply') });
    const cMs = Date.now() - c0;
    await rm(dir, { recursive: true, force: true });
    const perFrame = ai.frames.map((f) => f.ms);
    const mean = perFrame.reduce((s, v) => s + v, 0) / Math.max(perFrame.length, 1);
    const colmapLine = out.ok
      ? `registered ${out.registered.length}/${row.frames.length}${out.alignment ? `, alignment ${out.alignment.rmsCm.toFixed(2)} cm` : ''}, ${out.model.points} points (extract ${out.timings.extract.toFixed(1)} s, match ${out.timings.match.toFixed(1)} s, map ${out.timings.map.toFixed(1)} s)`
      : `no model: ${out.detail ?? out.reason}`;
    console.log(
      `${(row.label ?? row.id).padEnd(16)} ${String(row.frames.length).padStart(2)} frames | SAM 2: ${(aiMs / 1000).toFixed(1)} s total, ${mean.toFixed(0)} ms/frame (min ${Math.min(...perFrame)}, max ${Math.max(...perFrame)}), AI ok on ${ai.frames.filter((f) => f.state === 'ok').length}, ${ai.marks.length} marks | COLMAP ${(cMs / 1000).toFixed(1)} s: ${colmapLine}`,
    );
  }
  await db.end();
}

await main();

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../../config.ts';
import type { ScanIntrinsics } from '@roofline/shared';

/*
 * COLMAP behind a process boundary. The refinement's heavy lifting (SIFT, matching, incremental mapping with known fixed
 * intrinsics, the similarity into ARKit's world) is apps/worker/python/colmap_refine.py, run with a python that has pycolmap.
 * The job writes the photos and a small JSON into a temp directory, this runs the script on it, and the script's JSON comes
 * back. Nothing here knows COLMAP: a fake runner stands in for it in the tests.
 */

export type ColmapImage = {
  frameId: string;
  /** The photo on disk. */
  path: string;
  imageWidth: number;
  imageHeight: number;
  intrinsics: ScanIntrinsics;
  /** ARKit camera-to-world, 16 numbers, column-major. */
  cameraTransform: number[];
};

export type ColmapJob = {
  images: ColmapImage[];
  /** Where the script keeps its database and sparse models. */
  workDir: string;
  /** Where it writes the aligned sparse points (an ascii PLY). */
  plyPath: string;
};

export type ColmapAlignment = {
  method: 'centres' | 'orientations';
  scale: number;
  rmsCm: number;
  maxCm: number;
  rotationRmsDeg: number;
  rotationMaxDeg: number;
  registered: number;
  total: number;
  perFrameCm: Record<string, number>;
  perFrameDeg: Record<string, number>;
};

export type ColmapOutput =
  | { ok: false; reason: string; detail?: string }
  | {
      ok: true;
      aligned: boolean;
      reason?: string;
      detail?: string;
      registered: string[];
      unregistered: string[];
      model: { images: number; points: number; meanReprojPx: number; meanTrackLength: number; models: number };
      timings: { extract: number; match: number; map: number; align?: number };
      alignment?: ColmapAlignment;
      /** The aligned cameras: ARKit camera-to-world transforms in ARKit's world, for the registered frames. */
      poses?: Record<string, { cameraTransform: number[]; numPoints: number }>;
      points?: { count: number; ply: string | null };
    };

export interface ColmapRunner {
  readonly configured: boolean;
  run(job: ColmapJob): Promise<ColmapOutput>;
}

/** The script that ships with the worker. */
export const COLMAP_SCRIPT = fileURLToPath(new URL('../../../../worker/python/colmap_refine.py', import.meta.url));

/** The runner for this machine's config: null without SCAN_COLMAP_PYTHON (or when the python or the script is not there). */
export function createColmapRunner(config: Pick<Config, 'SCAN_COLMAP_PYTHON' | 'SCAN_COLMAP_SCRIPT' | 'SCAN_COLMAP_TIMEOUT_S'>): ColmapRunner | null {
  const python = config.SCAN_COLMAP_PYTHON;
  const script = config.SCAN_COLMAP_SCRIPT ?? COLMAP_SCRIPT;
  if (python === undefined || !existsSync(python) || !existsSync(script)) return null;
  return new PythonColmapRunner({ python, script, timeoutMs: config.SCAN_COLMAP_TIMEOUT_S * 1000 });
}

export class PythonColmapRunner implements ColmapRunner {
  readonly configured = true;
  private readonly python: string;
  private readonly script: string;
  private readonly timeoutMs: number;

  constructor(o: { python: string; script: string; timeoutMs: number }) {
    this.python = o.python;
    this.script = o.script;
    this.timeoutMs = o.timeoutMs;
  }

  async run(job: ColmapJob): Promise<ColmapOutput> {
    await mkdir(job.workDir, { recursive: true });
    const input = path.join(job.workDir, 'in.json');
    const output = path.join(job.workDir, 'out.json');
    await rm(output, { force: true });
    await writeFile(input, JSON.stringify({ images: job.images, workDir: path.join(job.workDir, 'colmap'), plyPath: job.plyPath, options: {} }));
    const tail = await new Promise<{ code: number | null; stderr: string; timedOut: boolean }>((resolve, reject) => {
      // -I: isolated mode, so nothing in the work directory is imported as code
      const child = spawn(this.python, ['-I', this.script, '--input', input, '--output', output], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-2000);
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stderr, timedOut });
      });
    });
    if (tail.timedOut) return { ok: false, reason: 'timeout', detail: `COLMAP ran longer than ${Math.round(this.timeoutMs / 1000)} seconds.` };
    if (!existsSync(output)) return { ok: false, reason: 'error', detail: `COLMAP did not answer (exit ${tail.code}): ${tail.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)}` };
    try {
      return JSON.parse(await readFile(output, 'utf8')) as ColmapOutput;
    } catch {
      return { ok: false, reason: 'error', detail: 'COLMAP answered with something unreadable.' };
    }
  }
}

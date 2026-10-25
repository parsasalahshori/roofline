import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, test } from 'vitest';
import { COLMAP_SCRIPT, type ColmapOutput, PythonColmapRunner } from '@roofline/api';
import { computeRefinedScan, computeScanResult, type ScanFrame, type ScanMark, type ScanWall, scanEffectiveFrames, scanMat4InverseRigid } from '@roofline/shared';

/*
 * The COLMAP refinement against a scene whose truth is known (apps/worker/python/synthetic_scene.py): eight photos of a textured
 * brick wall with a recessed window, drawn from ARKit-style poses, reported with a little tracking noise (3 mm, 0.05 degrees),
 * the window's corners marked on them with 0.8 px of noise. The script runs for real (SIFT, matching, mapping, alignment to
 * ARKit's world); the refined poses must be nearer the truth than the phone's were, and the window must come out within 1/8 in.
 * Needs a python with pycolmap (SCAN_COLMAP_PYTHON, else the venv this project was built with); skipped without one.
 */

const PYTHON = process.env.SCAN_COLMAP_PYTHON ?? '/Users/parsasalahshori-a/RooflineWork/colmap-venv/bin/python';
const HAVE_PYTHON = existsSync(PYTHON);
const PY_DIR = path.dirname(COLMAP_SCRIPT);
const run = promisify(execFile);

const work = mkdtempSync(path.join(tmpdir(), 'colmap-synthetic-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

type Scene = {
  frames: (ScanFrame & { path: string })[];
  marks: ScanMark[];
  wall: ScanWall;
  truth: { cornersM: [number, number, number][]; widthIn: number; heightIn: number; poses: Record<string, number[]> };
};

const centre = (m: readonly number[]) => [m[12]!, m[13]!, m[14]!] as const;
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
/** The angle between two camera orientations, degrees. */
function angleDeg(a: readonly number[], b: readonly number[]): number {
  // trace(Ra Rb^T)
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) tr += a[i * 4 + j]! * b[i * 4 + j]!;
  return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
}

describe.skipIf(!HAVE_PYTHON)('COLMAP refinement on a synthetic window scan', () => {
  test('the pose conventions and the similarity transform (the script’s own self-test, no COLMAP)', async () => {
    const { stdout } = await run(PYTHON, ['-I', COLMAP_SCRIPT, '--selftest']);
    expect(stdout).toContain('selftest ok');
  });

  test('refined poses are nearer the truth than the phone’s, the cloud sits on the wall, and the window is within 1/8 in', { timeout: 180_000 }, async () => {
    const dir = path.join(work, 'scene');
    const t0 = Date.now();
    await run(PYTHON, ['-I', path.join(PY_DIR, 'synthetic_scene.py'), '--out', dir, '--seed', '7']);
    const renderMs = Date.now() - t0;
    const scene = JSON.parse(readFileSync(path.join(dir, 'scene.json'), 'utf8')) as Scene;
    expect(scene.frames).toHaveLength(8);

    const runner = new PythonColmapRunner({ python: PYTHON, script: COLMAP_SCRIPT, timeoutMs: 300_000 });
    const t1 = Date.now();
    const out: ColmapOutput = await runner.run({
      images: scene.frames.map((f) => ({ frameId: f.frameId, path: path.join(dir, f.path), imageWidth: f.imageWidth, imageHeight: f.imageHeight, intrinsics: f.intrinsics, cameraTransform: f.cameraTransform })),
      workDir: path.join(work, 'run'),
      plyPath: path.join(work, 'cloud.ply'),
    });
    const colmapMs = Date.now() - t1;
    if (!out.ok || !out.aligned || out.alignment === undefined || out.poses === undefined) throw new Error(`COLMAP did not give an aligned model: ${JSON.stringify(out)}`);

    // 1. Everything registered, and lined up with ARKit well inside the 2 cm / 4 frame rule
    expect(out.registered).toHaveLength(8);
    expect(out.alignment.method).toBe('centres');
    expect(out.alignment.rmsCm).toBeLessThan(1);
    expect(out.alignment.rotationRmsDeg).toBeLessThan(0.5);
    expect(out.model.meanReprojPx).toBeLessThan(0.5);

    // 2. The refined cameras are nearer the truth (in position and in orientation) than the ones the "phone" reported
    const posErr = (m: readonly number[], id: string) => dist(centre(m), centre(scene.truth.poses[id]!)) * 1000;
    const arkitErr = scene.frames.map((f) => posErr(f.cameraTransform, f.frameId));
    const refinedErr = scene.frames.map((f) => posErr(out.poses![f.frameId]!.cameraTransform, f.frameId));
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    const rotErr = scene.frames.map((f) => angleDeg(out.poses![f.frameId]!.cameraTransform, scene.truth.poses[f.frameId]!));
    const rotArkit = scene.frames.map((f) => angleDeg(f.cameraTransform, scene.truth.poses[f.frameId]!));
    expect(mean(refinedErr)).toBeLessThan(mean(arkitErr));
    expect(Math.max(...refinedErr)).toBeLessThan(8);
    // The alignment's rotation comes from the camera centres (3 mm of noise over a metre or two of spread): a tenth of a degree
    expect(mean(rotErr)).toBeLessThan(0.15);
    expect(Math.max(...rotErr)).toBeLessThan(0.3);

    // 3. The sparse points are in ARKit's world, in metres: most of them on the wall (z = 0), some deeper in the opening (z = -0.10)
    const ply = readFileSync(path.join(work, 'cloud.ply'), 'utf8').split('\n');
    const start = ply.indexOf('end_header') + 1;
    const pts = ply.slice(start).filter((l) => l.trim() !== '').map((l) => l.split(' ').map(Number));
    expect(pts.length).toBeGreaterThan(1500);
    const onWall = pts.filter((p) => Math.abs(p[2]!) < 0.02).length / pts.length;
    expect(onWall).toBeGreaterThan(0.7);
    expect(pts.some((p) => Math.abs(p[2]! + 0.1) < 0.02)).toBe(true);

    // 4. The window, triangulated from the marks with each set of poses (the same shared maths the server runs)
    const poses = Object.fromEntries(Object.entries(out.poses).map(([id, p]) => [id, p.cameraTransform]));
    const refinedFrames = scanEffectiveFrames(scene.frames, poses);
    const withArkit = computeScanResult(scene.frames, scene.marks, scene.wall);
    const withColmap = computeScanResult(refinedFrames, scene.marks, scene.wall);
    const refinedScan = computeRefinedScan(refinedFrames, scene.marks, [], scene.wall);
    const sizeErr = (c: { widthIn: number | null; heightIn: number | null }) => Math.max(Math.abs(c.widthIn! - scene.truth.widthIn), Math.abs(c.heightIn! - scene.truth.heightIn));
    expect(sizeErr(withColmap)).toBeLessThan(0.125);
    expect(sizeErr(refinedScan.comp)).toBeLessThan(0.125);
    expect(withColmap.status).toBe('measured');
    // the (inverse) camera transform of a refined pose is still a proper rigid transform
    for (const p of Object.values(poses)) expect(scanMat4InverseRigid(p)).toHaveLength(16);

    const fmt = (v: number) => v.toFixed(2);
    console.log(
      [
        `synthetic scene: ${scene.frames.length} frames 960x720 (intrinsics 1920x1440), truth ${scene.truth.widthIn} x ${scene.truth.heightIn} in`,
        `render ${renderMs} ms, COLMAP job ${colmapMs} ms (extract ${Math.round(out.timings.extract * 1000)}, match ${Math.round(out.timings.match * 1000)}, map ${Math.round(out.timings.map * 1000)}, align ${Math.round((out.timings.align ?? 0) * 1000)})`,
        `registered ${out.registered.length}/8, ${out.model.points} points (${pts.length} kept), model reproj ${fmt(out.model.meanReprojPx)} px`,
        `alignment to ARKit: ${out.alignment.method}, scale ${out.alignment.scale.toFixed(4)}, rms ${fmt(out.alignment.rmsCm)} cm (max ${fmt(out.alignment.maxCm)}), rotation rms ${fmt(out.alignment.rotationRmsDeg)} deg`,
        `camera position error vs truth, mm: ARKit mean ${fmt(mean(arkitErr))} (max ${fmt(Math.max(...arkitErr))}) -> refined mean ${fmt(mean(refinedErr))} (max ${fmt(Math.max(...refinedErr))})`,
        `camera rotation error vs truth, deg: ARKit mean ${fmt(mean(rotArkit))} -> refined mean ${fmt(mean(rotErr))} (max ${fmt(Math.max(...rotErr))})`,
        `cloud: ${(onWall * 100).toFixed(0)}% within 2 cm of the wall plane`,
        `window size error vs truth, in: ARKit poses ${fmt(sizeErr(withArkit))} -> COLMAP poses ${fmt(sizeErr(withColmap))} (${fmt(withColmap.widthIn!)} x ${fmt(withColmap.heightIn!)})`,
      ].join('\n'),
    );
  });
});

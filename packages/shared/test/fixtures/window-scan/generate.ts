// Writes the window-scan JSON fixtures next to this file: `npx tsx packages/shared/test/fixtures/window-scan/generate.ts`.
// Each file is a whole scan (frames, marks, the phone's wall plane) with what computeScanResult must give for it. The iOS
// Core tests run the same files through the Swift port, so the two stay in step (docs/windows/scan-contract.md).
import { writeFileSync } from 'node:fs';
import { computeScanResult, type ScanFrame, type ScanMark } from '../../../src/window-scan.ts';
import { buildScene, type SceneOptions } from '../window-scan-scene.ts';

const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

const CASES: { file: string; name: string; description: string; options: SceneOptions }[] = [
  {
    file: 'clean-34x55.json',
    name: 'clean',
    description: 'A 34.625 x 55.75 in window from 5 regular frames and 4 close-ups, marks within +/- 1 px: every gate passes (status measured).',
    options: { noisePx: 1, seed: 7 },
  },
  {
    file: 'few-marks.json',
    name: 'few marks',
    description: 'The same window from 3 regular frames and no close-ups, but the third frame has no marks: every corner has only 2 marks (too_few_frames), so the scan needs review; no_closeups is a warning only.',
    options: { noisePx: 1, seed: 2, closeups: [], regular: [[-1.4, 1.2, 0], [1.4, 1.2, 0], [0, 1.3, 0]], drop: ['r3:0', 'r3:1', 'r3:2', 'r3:3'] },
  },
  {
    file: 'skewed-corner.json',
    name: 'skewed corner',
    description: 'The bottom right corner is 2 in lower than a rectangle would put it: opposite sides differ (sym_ratio) while every mark agrees with its triangulated corner.',
    options: { noisePx: 0.5, seed: 6, cornerOffsets: { 2: [0, -2 * 0.0254, 0] } },
  },
  {
    file: 'bad-mark.json',
    name: 'bad mark',
    description: 'One top right mark on regular frame r2 is 12 px right and 9 px up of where the corner is: reprojection fails (worst mark over 8 px); the size is still close.',
    options: { noisePx: 1, seed: 4, nudges: [['r2', 1, 12, -9]] },
  },
];

for (const c of CASES) {
  const scene = buildScene(c.options);
  const frames: ScanFrame[] = scene.frames.map((f) => ({ ...f, cameraTransform: f.cameraTransform.map((v) => r(v, 9)) }));
  const marks: ScanMark[] = scene.marks;
  const out = computeScanResult(frames, marks, scene.wall);
  const fixture = {
    name: c.name,
    description: c.description,
    convention: 'cameraTransform is column-major (translation = elements 12, 13, 14); marks are native image pixels; corners are 0 TL, 1 TR, 2 BR, 3 BL. Compare numbers within expected.tolerance.',
    truth: { widthIn: scene.truth.widthIn, heightIn: scene.truth.heightIn },
    input: { frames, marks, wall: scene.wall },
    expected: {
      status: out.status,
      failed: out.quality.failed,
      widthIn: out.widthIn === null ? null : r(out.widthIn, 4),
      heightIn: out.heightIn === null ? null : r(out.heightIn, 4),
      cornersM: out.cornersM === null ? null : out.cornersM.map((p) => p.map((v) => r(v, 6))),
      triangulatedM: out.triangulatedM.map((p) => (p === null ? null : p.map((v) => r(v, 6)))),
      quality: out.quality,
      tolerance: { inches: 0.01, metres: 0.0005, pixels: 0.05 },
    },
  };
  writeFileSync(new URL(c.file, import.meta.url), `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(c.file, out.status, out.quality.failed.join(',') || '-', out.widthIn?.toFixed(3), out.heightIn?.toFixed(3));
}

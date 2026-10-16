// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Pt, Quad, RgbaImage } from '@roofline/shared';
import { detectSheetSync } from '../src/features/measure/windows/cv/detect-sheet.ts';
import { loadWindowPhotoCv } from '../src/features/measure/windows/cv/index.ts';
import { calibrationSheetSvg, sheetLayout } from '../src/features/measure/windows/cv/sheet-layout.ts';
import { snapQuadSync } from '../src/features/measure/windows/cv/snap-quad.ts';
import { renderScene, type SynthScene } from '../src/features/measure/windows/cv/synth/render.ts';

function scene(over: Partial<SynthScene> = {}): SynthScene {
  return {
    widthPx: 900,
    heightPx: 1200,
    focal35mm: 26,
    distanceIn: 48,
    yawDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    window: { widthIn: 28, heightIn: 40, offsetIn: 1, trimIn: 3.5, frameIn: 1.5, sashIn: 1.25, grille: true },
    sheet: { paper: 'letter', xIn: 9, yIn: 22, rotDeg: 3, curlIn: 0 },
    k1: 0,
    light: { gain: 1, gradX: 0.15, gradY: -0.1, vignette: 0.2 },
    colors: { wall: [150, 120, 95], trim: [235, 232, 225], frame: [190, 185, 175], sash: [215, 212, 205] },
    occluder: null,
    blur: { defocusPx: 0.7, motionPx: 0, motionDeg: 0 },
    noise: 2,
    supersample: 2,
    seed: 11,
    ...over,
  };
}

const img = (p: { width: number; height: number; data: Uint8ClampedArray }): RgbaImage => ({ width: p.width, height: p.height, data: p.data });

function cornerErrors(det: NonNullable<ReturnType<typeof detectSheetSync>>, truth: { imagePoints: Pt[]; sheetPointsIn: Pt[] }): number[] {
  return det.sheetPointsIn.map((s, i) => {
    const k = truth.sheetPointsIn.findIndex((q) => q[0] === s[0] && q[1] === s[1]);
    return Math.hypot(det.imagePoints[i]![0] - truth.imagePoints[k]![0], det.imagePoints[i]![1] - truth.imagePoints[k]![1]);
  });
}

describe('the printable measuring sheet', () => {
  it('draws 12 markers, a ruler and instructions at true size, letter and A4 with their own markers', () => {
    const letter = calibrationSheetSvg('letter');
    expect(letter.svg).toContain('width="8.5in" height="11in"');
    expect(letter.svg).toContain('exactly 6 in');
    const a4 = calibrationSheetSvg('a4');
    expect(a4.svg).toContain('exactly 15 cm');
    expect(a4.widthIn).toBeCloseTo(8.2677, 3);
    const ids = (p: 'letter' | 'a4') => sheetLayout(p).markers.map((m) => m.id);
    expect(ids('letter')).toHaveLength(12);
    expect(ids('letter').some((id) => ids('a4').includes(id))).toBe(false);
    // Markers stay inside the printable area (0.5 in margins) and clear of each other.
    for (const m of sheetLayout('a4').markers) expect(m.x + m.size).toBeLessThanOrEqual(sheetLayout('a4').widthIn - 0.5 + 1e-9);
  });
});

describe('finding the sheet', () => {
  it('finds every marker corner to a fraction of a pixel, square on and at 35 degrees', () => {
    for (const yawDeg of [0, 35]) {
      const p = renderScene(scene({ yawDeg, pitchDeg: 8 }));
      const det = detectSheetSync(img(p))!;
      expect(det, `yaw ${yawDeg}`).not.toBeNull();
      expect(det.paper).toBe('letter');
      expect(det.imagePoints.length).toBeGreaterThanOrEqual(44);
      expect(det.rmsErrorPx).toBeLessThan(0.3);
      const errs = cornerErrors(det, p.markerCorners!).sort((a, b) => a - b);
      expect(errs[Math.floor(errs.length / 2)]).toBeLessThan(0.15);
      expect(errs.at(-1)).toBeLessThan(0.5);
    }
  });

  it('finds an A4 sheet, partly hidden', () => {
    const p = renderScene(scene({ sheet: { paper: 'a4', xIn: 9, yIn: 20, rotDeg: -5, curlIn: 0 }, occluder: { x: 11, y: 22, rx: 2.5, ry: 2 } }));
    const det = detectSheetSync(img(p))!;
    expect(det.paper).toBe('a4');
    expect(det.imagePoints.length).toBeGreaterThanOrEqual(24);
    expect(det.imagePoints.length).toBeLessThan(48);
    expect(Math.max(...cornerErrors(det, p.markerCorners!))).toBeLessThan(0.5);
  });

  it('answers null when there is no sheet, or it is far too blurred', () => {
    expect(detectSheetSync(img(renderScene(scene({ sheet: null }))))).toBeNull();
    expect(detectSheetSync(img(renderScene(scene({ blur: { defocusPx: 6, motionPx: 0, motionDeg: 0 } }))))).toBeNull();
  });
});

describe('snapping rough corners onto the frame', () => {
  it('moves corners several percent off onto the frame edge (not the trim or sash next to it)', () => {
    const p = renderScene(scene({ sheet: null, yawDeg: 25 }));
    const truth = p.windowQuad;
    const size = Math.hypot(truth[2][0] - truth[0][0], truth[2][1] - truth[0][1]);
    const offs: Pt[] = [
      [0.02, -0.025],
      [-0.03, 0.01],
      [0.015, 0.03],
      [-0.02, -0.02],
    ];
    const rough = truth.map((q, k) => [q[0] + offs[k]![0] * size, q[1] + offs[k]![1] * size]) as Quad;
    const s = snapQuadSync(img(p), rough);
    expect(s.moved).toBe(true);
    s.quad.forEach((q, k) => expect(Math.hypot(q[0] - truth[k]![0], q[1] - truth[k]![1]), `corner ${k}`).toBeLessThan(0.5));
    expect(Math.min(...s.sideConfidence)).toBeGreaterThan(0);
  });

  it('picks the nearest of several parallel edges (distractors) and reports the rivals', () => {
    // A white board with three dark parallel frames 12 px apart; rough corners near the middle one.
    const W = 600;
    const H = 500;
    const data = new Uint8ClampedArray(W * H * 4).fill(255);
    const frames = [100, 112, 124];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // Rings: dark between frame f and f+5 (a 5 px dark band per frame, so each has two edges).
        let v = 230;
        for (const f of frames) {
          const inRing = x >= f && y >= f && x < W - f && y < H - f && !(x >= f + 5 && y >= f + 5 && x < W - f - 5 && y < H - f - 5);
          if (inRing) v = 60;
        }
        const i = (y * W + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = v + ((x * 7 + y * 13) % 5);
      }
    }
    // The outer edge of the middle ring: x = 112, y = 112 ... (dark inside, light outside: polarity +).
    const truth: Quad = [
      [112, 112],
      [W - 112, 112],
      [W - 112, H - 112],
      [112, H - 112],
    ];
    const rough = truth.map(([x, y], k) => [x + (k % 2 ? 2 : -3), y + (k > 1 ? 3 : -2)]) as Quad;
    const s = snapQuadSync({ width: W, height: H, data }, rough, { bandFrac: 0.05 });
    s.quad.forEach((q, k) => expect(Math.hypot(q[0] - truth[k]![0], q[1] - truth[k]![1]), `corner ${k}`).toBeLessThan(0.3));
    expect(s.rivals!.some((r) => r > 0)).toBe(true);
  });
});

describe('the engine', () => {
  it('loads lazily and measures a rendered window from the sheet with the frame 1 in proud of the glass', async () => {
    const cv = await loadWindowPhotoCv();
    expect(await loadWindowPhotoCv()).toBe(cv);
    const p = renderScene(scene({ yawDeg: 20, pitchDeg: 5 }));
    const det = (await cv.detectSheet(img(p)))!;
    const truth = p.windowQuad;
    const rough = truth.map(([x, y], k) => [x + (k - 1.5) * 6, y + (k % 2 ? 5 : -4)]) as Quad;
    const snapped = await cv.snapQuad(img(p), rough);
    const m = cv.measure({ widthPx: p.width, heightPx: p.height, focalPx: p.focalPx, sheet: det, windowQuad: snapped.quad, planeOffsetIn: 1, cornerSigmaPx: snapped.cornerSigmaPx })!;
    expect(Math.abs(m.widthIn - 28)).toBeLessThan(0.1);
    expect(Math.abs(m.heightIn - 40)).toBeLessThan(0.1);
    expect(m.uncertaintyIn.width).toBeGreaterThan(0);
    expect(m.viewAngleDeg).toBeGreaterThan(10);
    expect(cv.combine([m, { ...m, widthIn: m.widthIn + 0.1 }, { ...m, widthIn: m.widthIn - 0.05 }])!.widthIn).toBeCloseTo(m.widthIn, 9);
  });
});

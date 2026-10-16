import { describe, expect, it } from 'vitest';
import { combineSheetMeasurements, fitSheetHomography, measureWithSheet, poseFromHomography, SHEET_WARNINGS } from '../src/window-photo-sheet.ts';
import type { Pt, Quad } from '../src/window-photo-math.ts';

type V3 = [number, number, number];

/** A pinhole camera looking at the glass (z = 0, sheet coordinates in inches) from `distanceIn`, turned by yaw/pitch. */
function camera(o: { distanceIn: number; yawDeg: number; pitchDeg: number; focalPx: number; w: number; h: number; target?: V3 }) {
  const target = o.target ?? [20, 30, 0];
  const yaw = (o.yawDeg * Math.PI) / 180;
  const pitch = (o.pitchDeg * Math.PI) / 180;
  // Camera centre in front of the glass (negative z), swung around the target.
  const C: V3 = [target[0] + o.distanceIn * Math.sin(yaw) * Math.cos(pitch), target[1] - o.distanceIn * Math.sin(pitch), -o.distanceIn * Math.cos(yaw) * Math.cos(pitch)];
  const f = norm(sub(target, C));
  const right = cross(f, [0, -1, 0]);
  const x = norm(right);
  const y = cross(f, x);
  const R = [x, y, f];
  const project = (P: V3): Pt => {
    const d = sub(P, C);
    const cam = R.map((row) => row[0] * d[0] + row[1] * d[1] + row[2] * d[2]) as V3;
    return [o.focalPx * (cam[0] / cam[2]) + o.w / 2, o.focalPx * (cam[1] / cam[2]) + o.h / 2];
  };
  return { project, C };
}
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** The sheet's 48 marker corners (a 3 x 4 grid of 1.875 in squares) placed with its top-left at (ox, oy) on the glass. */
function sheetPoints(ox: number, oy: number): Pt[] {
  const pts: Pt[] = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      const x = 0.5 + c * 2.8125;
      const y = 0.5 + r * 2.275;
      pts.push([x, y], [x + 1.875, y], [x + 1.875, y + 1.875], [x, y + 1.875]);
    }
  }
  return pts.map(([x, y]) => [x + ox, y + oy]);
}

function scene(o: { yawDeg: number; pitchDeg: number; distanceIn: number; offsetIn: number; noisePx?: number; seed?: number }) {
  const w = 4032;
  const h = 3024;
  const focalPx = (26 / 36) * w;
  const cam = camera({ distanceIn: o.distanceIn, yawDeg: o.yawDeg, pitchDeg: o.pitchDeg, focalPx, w, h, target: [18, 30, 0] });
  // A 36 x 60 in window frame at (0..36, 0..60), offsetIn toward the camera from the glass; the sheet in its middle.
  const sheetIn = sheetPoints(13.75, 25);
  let s = o.seed ?? 1;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
  const n = o.noisePx ?? 0;
  const imagePoints = sheetIn.map(([x, y]) => {
    const p = cam.project([x, y, 0]);
    return [p[0] + n * 2 * rnd(), p[1] + n * 2 * rnd()] as Pt;
  });
  // Sheet coordinates are relative to the sheet's own corner.
  const sheetPointsIn = sheetIn.map(([x, y]) => [x - 13.75, y - 25] as Pt);
  const windowQuad = ([[0, 0], [36, 0], [36, 60], [0, 60]] as Pt[]).map(([x, y]) => cam.project([x, y, -o.offsetIn])) as Quad;
  return { w, h, focalPx, imagePoints, sheetPointsIn, windowQuad, C: cam.C };
}

describe('least-squares sheet homography', () => {
  it('is exact for exact points and reports zero RMS', () => {
    const s = scene({ yawDeg: 25, pitchDeg: 10, distanceIn: 100, offsetIn: 0 });
    const fit = fitSheetHomography(s.sheetPointsIn, s.imagePoints)!;
    expect(fit.rmsPx).toBeLessThan(1e-6);
    expect(fit.inlierCount).toBe(48);
  });

  it('drops wrong matches (a misread marker) and keeps the rest', () => {
    const s = scene({ yawDeg: 15, pitchDeg: 5, distanceIn: 90, offsetIn: 0, noisePx: 0.3 });
    const bad = s.imagePoints.map((p, i) => (i >= 8 && i < 12 ? ([p[0] + 60, p[1] - 40] as Pt) : p));
    const fit = fitSheetHomography(s.sheetPointsIn, bad)!;
    expect(fit.inlierCount).toBe(44);
    expect(fit.inliers.slice(8, 12)).toEqual([false, false, false, false]);
    expect(fit.rmsPx).toBeLessThan(0.4);
  });
});

describe('pose from the homography', () => {
  it('recovers the camera centre (distance) from the sheet', () => {
    const s = scene({ yawDeg: 30, pitchDeg: -12, distanceIn: 110, offsetIn: 0 });
    const fit = fitSheetHomography(s.sheetPointsIn, s.imagePoints)!;
    const pose = poseFromHomography(fit.H, s.focalPx, s.w / 2, s.h / 2)!;
    // Sheet coordinates are offset by the sheet's corner (13.75, 25).
    expect(pose.centre[0] + 13.75).toBeCloseTo(s.C[0], 3);
    expect(pose.centre[1] + 25).toBeCloseTo(s.C[1], 3);
    expect(pose.centre[2]).toBeCloseTo(s.C[2], 3);
  });
});

describe('measuring with the sheet', () => {
  it('sizes the window exactly, square on and at 40 degrees', () => {
    for (const yawDeg of [0, 20, 40]) {
      const s = scene({ yawDeg, pitchDeg: 8, distanceIn: 120, offsetIn: 0 });
      const m = measureWithSheet({ widthPx: s.w, heightPx: s.h, focalPx: s.focalPx, imagePoints: s.imagePoints, sheetPointsIn: s.sheetPointsIn, windowQuad: s.windowQuad, planeOffsetIn: 0 })!;
      expect(m.widthIn).toBeCloseTo(36, 6);
      expect(m.heightIn).toBeCloseTo(60, 6);
      expect(m.distanceIn).toBeCloseTo(Math.abs(s.C[2]), 3);
    }
  });

  it('corrects the frame sitting in front of the glass (oblique, exact), and the uncorrected answer is off by about offset/distance', () => {
    const s = scene({ yawDeg: 35, pitchDeg: 10, distanceIn: 80, offsetIn: 2 });
    const args = { widthPx: s.w, heightPx: s.h, focalPx: s.focalPx, imagePoints: s.imagePoints, sheetPointsIn: s.sheetPointsIn, windowQuad: s.windowQuad };
    const fixed = measureWithSheet({ ...args, planeOffsetIn: 2 })!;
    expect(fixed.widthIn).toBeCloseTo(36, 6);
    expect(fixed.heightIn).toBeCloseTo(60, 6);
    const naive = measureWithSheet({ ...args, planeOffsetIn: 0 })!;
    // Closer to the camera looks bigger: the uncorrected size is too big by roughly offset / distance.
    expect(naive.widthIn - 36).toBeGreaterThan(0.5);
    expect(naive.heightIn / 60 - 1).toBeGreaterThan(0.015);
    // Behind the glass corrects the other way.
    const behind = scene({ yawDeg: -20, pitchDeg: 0, distanceIn: 100, offsetIn: -1.5 });
    const b = measureWithSheet({ widthPx: behind.w, heightPx: behind.h, focalPx: behind.focalPx, imagePoints: behind.imagePoints, sheetPointsIn: behind.sheetPointsIn, windowQuad: behind.windowQuad, planeOffsetIn: -1.5 })!;
    expect(b.widthIn).toBeCloseTo(36, 6);
  });

  it('reports a sensible uncertainty that grows with corner noise, plus the angle and warnings', () => {
    const s = scene({ yawDeg: 42, pitchDeg: 5, distanceIn: 120, offsetIn: 1, noisePx: 0.4 });
    const args = { widthPx: s.w, heightPx: s.h, focalPx: s.focalPx, imagePoints: s.imagePoints, sheetPointsIn: s.sheetPointsIn, windowQuad: s.windowQuad, planeOffsetIn: 1 };
    const tight = measureWithSheet({ ...args, cornerSigmaPx: 0.3 })!;
    const loose = measureWithSheet({ ...args, cornerSigmaPx: 4 })!;
    expect(Math.abs(tight.widthIn - 36)).toBeLessThan(0.15);
    expect(tight.uncertaintyIn.width).toBeGreaterThan(0.01);
    expect(loose.uncertaintyIn.width).toBeGreaterThan(tight.uncertaintyIn.width * 2);
    expect(tight.viewAngleDeg).toBeGreaterThan(35);
    expect(tight.warnings).toContain(SHEET_WARNINGS.steep);
    const wide = measureWithSheet({ ...args, focalPx: (14 / 36) * s.w });
    expect(wide?.warnings).toContain(SHEET_WARNINGS.ultraWide);
  });

  it('refuses too few points or mismatched lists', () => {
    const s = scene({ yawDeg: 0, pitchDeg: 0, distanceIn: 100, offsetIn: 0 });
    const args = { widthPx: s.w, heightPx: s.h, focalPx: s.focalPx, windowQuad: s.windowQuad, planeOffsetIn: 0 };
    expect(measureWithSheet({ ...args, imagePoints: s.imagePoints.slice(0, 7), sheetPointsIn: s.sheetPointsIn.slice(0, 7) })).toBeNull();
    expect(measureWithSheet({ ...args, imagePoints: s.imagePoints.slice(0, 9), sheetPointsIn: s.sheetPointsIn.slice(0, 10) })).toBeNull();
  });
});

describe('combining photos', () => {
  it('takes the median and the spread', () => {
    expect(combineSheetMeasurements([{ widthIn: 36.1, heightIn: 60 }, { widthIn: 35.9, heightIn: 60.2 }, { widthIn: 36.05, heightIn: 59.9 }])).toEqual({
      widthIn: 36.05,
      heightIn: 60,
      spreadIn: { width: expect.closeTo(0.2, 9), height: expect.closeTo(0.3, 9) },
    });
    expect(combineSheetMeasurements([])).toBeNull();
  });
});

describe('the pose model, two sheets and the print scale', () => {
  it('two sheets in opposite corners (each in its own inches, turned) fit one plane exactly', () => {
    const s = scene({ yawDeg: 30, pitchDeg: 6, distanceIn: 110, offsetIn: 1 });
    // Sheet B: the same points turned 90 degrees and shifted to the top-left of the glass; its inches are its own.
    const theta = Math.PI / 2;
    const bOrigin: Pt = [3, 3];
    const bPts = s.sheetPointsIn.map(([x, y]) => [Math.cos(theta) * x - Math.sin(theta) * y + bOrigin[0], Math.sin(theta) * x + Math.cos(theta) * y + bOrigin[1]] as Pt);
    // Project B through the same camera: reuse scene() geometry via a second call with the same camera.
    const cam = camera({ distanceIn: 110, yawDeg: 30, pitchDeg: 6, focalPx: s.focalPx, w: s.w, h: s.h, target: [18, 30, 0] });
    const bImg = bPts.map(([x, y]) => cam.project([x, y, 0]));
    const m = measureWithSheet({
      widthPx: s.w,
      heightPx: s.h,
      focalPx: s.focalPx,
      imagePoints: [...s.imagePoints, ...bImg],
      sheetPointsIn: [...s.sheetPointsIn, ...s.sheetPointsIn],
      sheetIndex: [...s.sheetPointsIn.map(() => 0), ...s.sheetPointsIn.map(() => 1)],
      windowQuad: s.windowQuad,
      planeOffsetIn: 1,
    })!;
    expect(m.widthIn).toBeCloseTo(36, 4);
    expect(m.heightIn).toBeCloseTo(60, 4);
  });

  it('applies the printed scale read off the ruler', () => {
    const s = scene({ yawDeg: 10, pitchDeg: 0, distanceIn: 100, offsetIn: 0 });
    // Printed at 98%: the true sheet is 0.98 of the nominal inches.
    const printed = s.sheetPointsIn.map(([x, y]) => [x / 0.98, y / 0.98] as Pt);
    const args = { widthPx: s.w, heightPx: s.h, focalPx: s.focalPx, imagePoints: s.imagePoints, sheetPointsIn: printed, windowQuad: s.windowQuad, planeOffsetIn: 0 };
    expect(measureWithSheet(args)!.widthIn).toBeCloseTo(36 / 0.98, 3);
    expect(measureWithSheet({ ...args, printScale: 0.98 })!.widthIn).toBeCloseTo(36, 4);
    expect(measureWithSheet({ ...args, printScale: 0.98, planeModel: 'homography' })!.widthIn).toBeCloseTo(36, 4);
  });
});

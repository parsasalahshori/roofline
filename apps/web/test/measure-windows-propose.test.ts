// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Quad, RgbaImage } from '@roofline/shared';
import { detectSheetSync } from '../src/features/measure/windows/cv/detect-sheet.ts';
import { loadWindowPhotoCv } from '../src/features/measure/windows/cv/index.ts';
import { proposeQuadSync } from '../src/features/measure/windows/cv/propose-quad.ts';
import { renderScene, type SynthScene } from '../src/features/measure/windows/cv/synth/render.ts';

function scene(over: Partial<SynthScene> = {}): SynthScene {
  return {
    widthPx: 900,
    heightPx: 1200,
    focal35mm: 26,
    distanceIn: 60,
    yawDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    window: { widthIn: 28, heightIn: 40, offsetIn: 1, trimIn: 3.5, frameIn: 1.5, sashIn: 1.25, grille: true },
    sheet: { paper: 'letter', xIn: 9, yIn: 24, rotDeg: 5, curlIn: 0 },
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
const off = (a: Quad, b: Quad) => Math.max(...a.map((p, k) => Math.hypot(p[0] - b[k]![0], p[1] - b[k]![1])));

describe('proposing the window around the sheet (no corners from the person)', () => {
  it('the engine proposes the frame, turned sheet and angled photo, with the other layers ranked after it', async () => {
    const cv = await loadWindowPhotoCv();
    expect(typeof cv.proposeQuad).toBe('function');
    for (const over of [{}, { yawDeg: 25, pitchDeg: -8, rollDeg: 2 }]) {
      const p = renderScene(scene(over));
      const det = detectSheetSync(img(p))!;
      const s = (await cv.proposeQuad!(img(p), det, 'inside-frame'))!;
      expect(s).not.toBeNull();
      expect(off(s.quad, p.windowQuad)).toBeLessThan(2);
      expect(s.candidates!.length).toBeGreaterThanOrEqual(2);
      expect(s.cornerSigmaPx).toHaveLength(4);
    }
  });

  it('null when nothing rectangular encloses the sheet (only the sheet on a plain wall)', () => {
    const p = renderScene(scene());
    const det = detectSheetSync(img(p))!;
    // Everything but the sheet painted one grey.
    const data = new Uint8ClampedArray(p.data);
    const x0 = Math.min(...det.outline.map((q) => q[0])) - 4;
    const x1 = Math.max(...det.outline.map((q) => q[0])) + 4;
    const y0 = Math.min(...det.outline.map((q) => q[1])) - 4;
    const y1 = Math.max(...det.outline.map((q) => q[1])) + 4;
    for (let y = 0; y < p.height; y++)
      for (let x = 0; x < p.width; x++) {
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
        const j = (y * p.width + x) * 4;
        data[j] = data[j + 1] = data[j + 2] = 128;
      }
    const blank = { width: p.width, height: p.height, data };
    expect(proposeQuadSync(blank, detectSheetSync(blank) ?? det, 'inside-frame')).toBeNull();
  });

  it('the screen engineer\'s photo: the right outline is offered among the top 3', async () => {
    const { readFileSync } = await import('node:fs');
    const jpeg = (await import('jpeg-js')).default;
    const d = jpeg.decode(readFileSync(new URL('./fixtures/window-screen-regression.jpg', import.meta.url)), { useTArray: true });
    const photo: RgbaImage = { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.byteLength) };
    const truth: Quad = [
      [440.80700712878075, 495.7119237846491],
      [1071.7584473077704, 444.6587748602477],
      [1074.201836639525, 1538.9874195750406],
      [472.6194032437369, 1496.0667769073686],
    ];
    const det = detectSheetSync(photo)!;
    const s = proposeQuadSync(photo, det, 'inside-frame');
    expect(s).not.toBeNull();
    const ranks = s!.candidates!.map((c) => off(c.quad, truth));
    if (!ranks.slice(0, 3).some((e) => e < 2)) console.log(ranks);
    expect(ranks.slice(0, 3).some((e) => e < 2)).toBe(true);
  });
});

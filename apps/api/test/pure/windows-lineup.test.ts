import { describe, expect, it } from 'vitest';
import { correctedCamera, decodeGray, FIT_GOOD_SCORE, fitCorners, lineUp, sobel, wallQuad } from '../../src/estimator/windows-lineup.ts';
import { EAVE, inside, noise, render, scene, TRUE, WALL } from './facade-scenes.ts';

/*
 * Synthetic renders (facade-scenes.ts): a house's front wall drawn with a known camera (a textured wall, a dark roof
 * band over it, a grey street), saved as a JPEG. The line-up, given the camera off by a known heading and the wall
 * height off by a known share, must find both; blank or noise photos are 'unknown' or 'off', never 'good'. Strict
 * checks: walls with distractors (garage-door panels, porch posts and beams, a fence, the house further back or along
 * the street than the outline says) are never 'good'.
 */

function houseJpeg(): Uint8Array {
  return scene({ texture: 30 }).bytes;
}

const edgesOf = (bytes: Uint8Array) => sobel(decodeGray(bytes)!);

describe('the wall line-up', () => {
  const edges = edgesOf(houseJpeg());

  it('a wall drawn with the true camera and height lines up', () => {
    const r = lineUp(edges, TRUE, WALL, EAVE, { heightKnown: true });
    expect(r.fit).toBe('good');
    expect(r.failed).toEqual([]);
    expect(r.fitScore!).toBeGreaterThanOrEqual(FIT_GOOD_SCORE);
    expect(Math.abs(r.headingCorrectionDeg)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(r.eaveM! - EAVE) / EAVE).toBeLessThan(0.05);
  });

  it('recovers a 3 degree heading error and a 15% height error', () => {
    const r = lineUp(edges, { ...TRUE, heading: TRUE.heading - 3 }, WALL, EAVE / 1.15);
    expect(r.fit).toBe('good');
    expect(Math.abs(r.headingCorrectionDeg - 3)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(r.eaveM! - EAVE) / EAVE).toBeLessThan(0.05);
    // Before the line-up the drawn wall was off; after it, on the edges.
    expect(r.quadBefore![0][0]).not.toBeCloseTo(r.quad![0][0], 0);
  });

  it('a blank photo is unknown (no edges: blurred or blank)', () => {
    const r = lineUp(edgesOf(render(() => 128)), TRUE, WALL, EAVE);
    expect(r.fit).toBe('unknown');
    expect(r.blurred).toBe(true);
  });

  it('a noise photo never lines up', () => {
    const n = noise(3);
    const r = lineUp(edgesOf(render(() => 128 + 120 * n())), TRUE, WALL, EAVE);
    expect(r.fit).not.toBe('good');
    expect(r.failed.length).toBeGreaterThan(0);
  });

  it('a blurred house (smooth wall region in a sharp street) is unknown and flagged blurred', () => {
    const wall = wallQuad(TRUE, WALL, EAVE + 3)!;
    const n = noise(11);
    const bytes = render((x, y) => {
      if (inside([x + 0.5, y + 0.5], wall)) return 150 + 10 * Math.sin(x / 60);
      return ((x >> 3) + (y >> 3)) % 2 === 0 ? 60 + 5 * n() : 200 + 5 * n();
    });
    const r = lineUp(edgesOf(bytes), TRUE, WALL, EAVE);
    expect(r.fit).toBe('unknown');
    expect(r.blurred).toBe(true);
  });

  it('a photo that is not a JPEG is not decoded', () => {
    expect(decodeGray(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('the strict line-up: clean walls are good, distractors never are', () => {
  const fit = (bytes: Uint8Array, opts: { heightKnown?: boolean } = { heightKnown: true }, cam = TRUE, eave = EAVE) => lineUp(edgesOf(bytes), cam, WALL, eave, opts);
  const garage = { x0: -6, x1: -0.5, heightM: 2.13, panels: 3 };

  it.each([
    ['a smooth wall', {}],
    ['a rough wall', { texture: 30, seed: 2 }],
    ['a wall with a garage door on it (panels well under the eave)', { garage }],
    ['a wall with windows (their heads are short lines)', { windows: [{ x0: 1, x1: 2.2, sill: 0.9, head: 2.3 }, { x0: 3.5, x1: 4.7, sill: 0.9, head: 2.3 }] }],
    ['a wall behind porch posts', { porch: { depthM: 1.8, posts: [-1, 2.5], beamM: 2.6 } }],
  ])('clean: %s lines up', (_name, s) => {
    const r = fit(scene(s).bytes);
    expect(r.fit, r.failed.join(',')).toBe('good');
    expect(r.lines).toMatchObject({ left: expect.any(Number), right: expect.any(Number), eave: expect.any(Number), ground: expect.any(Number) });
  });

  it.each([
    ['the house 5 m further back, a garage door where the drawn wall falls', { realOffsetM: 5, garage: { x0: -7, x1: 0, heightM: 2.13, panels: 3 } }],
    ['the house 4 m back behind a porch (posts and a beam where the wall is drawn)', { realOffsetM: 4, porch: { depthM: 4, posts: [-7, 7], beamM: 2.6 } }],
    ['the house 6 m back and wider, with a garage door', { realOffsetM: 6, realWidenM: 3, garage: { x0: -9, x1: -1, heightM: 2.13, panels: 4 } }],
    ['no eave edge, a full-width garage door whose top could pass for one', { noRoof: true, garage: { x0: -7, x1: 7, heightM: 2.6, panels: 4 } }],
    ['the house 3 m back behind a garden wall', { realOffsetM: 3, fence: { x0: -7, x1: 7, heightM: 1.8, depthM: 3 } }],
  ])('distractor: %s is never good', (_name, s) => {
    for (const heightKnown of [true, false]) {
      const r = fit(scene(s).bytes, { heightKnown });
      expect(r.fit).not.toBe('good');
      expect(r.failed.length).toBeGreaterThan(0);
    }
  });

  it('the house further along the street than the heading search reaches (a garage door and a fence in its place): never good', () => {
    for (const turn of [7, 9, -9, 12]) {
      for (const g of [true, false]) {
        const bytes = scene({ garage: g ? garage : undefined, fence: { x0: 7.5, x1: 14, heightM: 1.8, depthM: 0 }, seed: 5 }, { ...TRUE, heading: TRUE.heading + turn }).bytes;
        const r = fit(bytes);
        expect(r.fit, `turn ${turn}`).not.toBe('good');
        expect(r.failed).toEqual(expect.arrayContaining(['left-corner']));
      }
    }
  });

  it('neither vertical corner on an edge: off (the wall plainly is not there), with the checks it failed', () => {
    const r = fit(scene({ seed: 5 }, { ...TRUE, heading: TRUE.heading + 12 }).bytes);
    expect(r.fit).toBe('off');
    expect(r.failed).toEqual(expect.arrayContaining(['left-corner', 'right-corner']));
  });

  it("Google's heights must agree with the photo's eave: 20% off is not confirmed; without heights it can still be", () => {
    const bytes = scene({ eaveM: EAVE * 1.2 }).bytes;
    const known = fit(bytes, { heightKnown: true });
    expect(known.fit).not.toBe('good');
    expect(known.failed).toContain('height');
    const assumed = fit(bytes, { heightKnown: false });
    expect(assumed.fit).toBe('good');
    expect(Math.abs(assumed.eaveM! - EAVE * 1.2) / (EAVE * 1.2)).toBeLessThan(0.05);
  });
});

describe('fitting dragged corners', () => {
  it('recovers heading, distance and wall height from the four corners', () => {
    const truth = correctedCamera(TRUE, WALL, 2.5, 1.2);
    const dragged = wallQuad(truth, WALL, 3.4)!;
    const fit = fitCorners(TRUE, WALL, dragged);
    expect(Math.abs(fit.headingCorrectionDeg - 2.5)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(fit.distanceScale - 1.2)).toBeLessThan(0.02);
    expect(Math.abs(fit.eaveM - 3.4) / 3.4).toBeLessThan(0.03);
    expect(fit.errorPx).toBeLessThan(2);
  });
});

import { describe, expect, it } from 'vitest';
import { fitWindowQuad, polygonMask, type Pt } from '../../src/providers/window-quad.ts';

/* The window quad from a binary mask, on drawn masks: a rectangle, a window seen at an angle, and the messes a real mask has. */

const W = 640;
const H = 800;
const quad = (tl: [number, number], tr: [number, number], br: [number, number], bl: [number, number]): Pt[] => [tl, tr, br, bl].map(([x, y]) => ({ x, y }));
const draw = (poly: Pt[]) => polygonMask(W, H, poly);

/** The largest distance of any fitted corner from where it should be. */
function off(got: Pt[], want: Pt[]): number {
  return Math.max(...got.map((g, i) => Math.hypot(g.x - want[i]!.x, g.y - want[i]!.y)));
}

describe('fitWindowQuad', () => {
  it('a clean rectangle: its four corners, quality near 1', () => {
    const want = quad([150, 200], [470, 200], [470, 640], [150, 640]);
    const fit = fitWindowQuad(draw(want), W, H)!;
    expect(fit).not.toBeNull();
    expect(off(fit.corners, want)).toBeLessThan(1.5);
    expect(fit.quality).toBeGreaterThan(0.95);
    expect(fit.fill).toBeGreaterThan(0.98);
    expect(fit.residual).toBeLessThan(0.002);
    expect(fit.support).toBeGreaterThan(0.95);
  });

  it('a window seen at an angle (a perspective quad): the slanted sides are found, not the box round them', () => {
    const want = quad([140, 180], [500, 240], [490, 700], [130, 610]);
    const fit = fitWindowQuad(draw(want), W, H)!;
    expect(fit).not.toBeNull();
    expect(off(fit.corners, want)).toBeLessThan(3);
    expect(fit.quality).toBeGreaterThan(0.9);
  });

  it('a lamp or a curtain bites a notch out of a corner and a side: the lines still run along the real sides', () => {
    const want = quad([150, 200], [470, 200], [470, 640], [150, 640]);
    const mask = draw(want);
    // A lamp covering the lower-left corner, a curtain edge notching the left side higher up
    for (let y = 540; y < 640; y++) for (let x = 150; x < 215; x++) mask[y * W + x] = 0;
    for (let y = 300; y < 360; y++) for (let x = 150; x < 175; x++) mask[y * W + x] = 0;
    const fit = fitWindowQuad(mask, W, H)!;
    expect(fit).not.toBeNull();
    expect(off(fit.corners, want)).toBeLessThan(4);
    // The mask does not fill the quad any more, and the fit says so a little, but it is still a usable quad
    expect(fit.fill).toBeLessThan(0.99);
    expect(fit.quality).toBeGreaterThan(0.75);
  });

  it('a ragged edge, specks round it and holes in it: the quad is the same', () => {
    const want = quad([150, 200], [470, 200], [470, 640], [150, 640]);
    const mask = draw(want);
    let seed = 7;
    const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    // Ragged: every edge pixel is moved in or out by up to 2 pixels
    for (let y = 200; y < 640; y++) {
      const l = 150 + Math.floor(rand() * 4) - 1;
      const r = 470 + Math.floor(rand() * 4) - 2;
      for (let x = 148; x < 153; x++) mask[y * W + x] = x >= l ? 1 : 0;
      for (let x = 466; x < 472; x++) mask[y * W + x] = x < r ? 1 : 0;
    }
    // Specks that are not the window, and holes inside it (a pane's reflection)
    for (let k = 0; k < 40; k++) mask[(10 + Math.floor(rand() * 100)) * W + 10 + Math.floor(rand() * 600)] = 1;
    for (let y = 300; y < 380; y++) for (let x = 250; x < 330; x++) mask[y * W + x] = 0;
    const fit = fitWindowQuad(mask, W, H)!;
    expect(fit).not.toBeNull();
    expect(off(fit.corners, want)).toBeLessThan(4);
    expect(fit.quality).toBeGreaterThan(0.85);
  });

  it('a sill sticking out below is part of the shape: the quad takes the longer bottom line', () => {
    const mask = draw(quad([150, 200], [470, 200], [470, 640], [150, 640]));
    for (let y = 640; y < 660; y++) for (let x = 130; x < 490; x++) mask[y * W + x] = 1;
    const fit = fitWindowQuad(mask, W, H)!;
    expect(fit).not.toBeNull();
    expect(fit.corners[2].y).toBeCloseTo(660, -1);
    expect(fit.corners[0].y).toBeCloseTo(200, -1);
  });

  it('the answer is the same every time for the same mask', () => {
    const mask = draw(quad([140, 180], [500, 240], [490, 700], [130, 610]));
    expect(fitWindowQuad(mask, W, H)).toEqual(fitWindowQuad(mask, W, H));
  });

  it('nothing believable: an empty mask, a speck, a round blob (not a quad: low quality), a window that runs off the picture', () => {
    expect(fitWindowQuad(new Uint8Array(W * H), W, H)).toBeNull();
    expect(fitWindowQuad(draw(quad([300, 300], [310, 300], [310, 310], [300, 310])), W, H)).toBeNull();
    // A disc
    const disc = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - 320) ** 2 + (y - 400) ** 2 < 200 ** 2) disc[y * W + x] = 1;
    const fit = fitWindowQuad(disc, W, H);
    if (fit !== null) expect(fit.quality).toBeLessThan(0.7);
    // A rectangle cut off by the left edge of the picture
    expect(fitWindowQuad(draw(quad([0, 200], [470, 200], [470, 640], [0, 640])), W, H)).toBeNull();
    // A wrong-sized buffer
    expect(fitWindowQuad(new Uint8Array(10), W, H)).toBeNull();
  });

  it('a side that is a wobbling curtain fold, not a line: either no quad or a less confident one', () => {
    const mask = draw(quad([150, 200], [470, 200], [470, 640], [150, 640]));
    for (let y = 200; y < 640; y++) {
      const cut = Math.round(45 + 35 * Math.sin(y / 18));
      for (let x = 150; x < 150 + cut; x++) mask[y * W + x] = 0;
    }
    const fit = fitWindowQuad(mask, W, H);
    if (fit !== null) expect(fit.quality).toBeLessThan(0.85);
  });
});

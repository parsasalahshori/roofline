import { describe, expect, it } from 'vitest';
import { DEFAULT_PHOTO_EDGE, photoEdges, type PhotoEdgeRaster } from '../src/roof-reconstruct/outline-photo.ts';
import { reconstructRoof } from '../src/roof-reconstruct/index.ts';
import type { XY } from '../src/roof-reconstruct/geom.ts';
import { CORRECT, render, ROOF, SHORT } from './fixtures/photo-scene.ts';

// Hidden eaves drawn from scratch (fixtures/photo-scene.ts): a rectangular house whose roof truly reaches x = 20 m, an
// outline that stops 1 m short of it on the east side (as the mask does under a crown), and a crown over that eave.

describe('photoEdges: hidden eaves from the photo', () => {
  for (const s of [0.1, 0.25]) {
    it(`moves an eave hidden under a sparse crown to the roof's edge (${s} m pixels)`, () => {
      const { raster, outline } = render({ roof: ROOF, crown: { x: 20, y: -16, r: 4, leaves: 0.5 } }, SHORT, s);
      const res = photoEdges(outline, raster);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const east = res.edges.find((e) => e.edge === 1)!;
      expect(east.status).toBe('moved');
      expect(Math.abs(east.offsetM - 1)).toBeLessThanOrEqual(s <= 0.1 ? 0.2 : 0.3);
      // Raster metres are the house frame plus 1 m east (render's centring): the true eave is at x = 21.
      const xs = res.outline.map((p) => p.x);
      expect(Math.max(...xs)).toBeGreaterThan(20.7);
      expect(Math.max(...xs)).toBeLessThan(21.35);
      // The other edges are where they were.
      expect(res.edges.filter((e) => e.edge !== 1).every((e) => e.status !== 'moved')).toBe(true);
    });

    it(`keeps the outline when the crown is dense: no evidence, no move (${s} m pixels)`, () => {
      const { raster, outline } = render({ roof: ROOF, crown: { x: 20, y: -16, r: 9, leaves: 1 } }, SHORT, s);
      const res = photoEdges(outline, raster);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.edges.every((e) => e.status !== 'moved')).toBe(true);
      expect(res.outline).toEqual(outline.map((p) => ({ x: p.x, y: p.y })));
      const east = res.edges.find((e) => e.edge === 1)!;
      expect(east.status).toBe('declined');
      expect(['no-coverage', 'weak-contrast', 'no-model']).toContain(east.reason);
    });
  }

  it('leaves a correct outline with visible eaves alone (every edge supported)', () => {
    const { raster, outline } = render({ roof: ROOF }, CORRECT, 0.1);
    const res = photoEdges(outline, raster);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.edges.every((e) => e.status === 'skipped' && e.reason === 'supported')).toBe(true);
    expect(res.outline).toEqual(outline);
  });

  it('confirms a hidden eave that is already right (the photo agrees with it)', () => {
    const { raster, outline } = render({ roof: ROOF, crown: { x: 20.5, y: -16, r: 2.5, leaves: 0.5 } }, CORRECT, 0.1);
    const res = photoEdges(outline, raster);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const east = res.edges.find((e) => e.edge === 1)!;
    expect(east.status === 'confirmed' || east.status === 'skipped' || east.status === 'declined').toBe(true);
    expect(res.outline).toEqual(outline);
  });

  it('will not sweep over ground the heights see, however roof-like it looks (a patio beyond the eave)', () => {
    // The yard east of the roof is roof-coloured concrete for 2 m: the photo alone would push the eave onto it, but the
    // gaps between the leaves show ground there.
    const { raster, outline } = render({ roof: ROOF, crown: { x: 20, y: -16, r: 4, leaves: 0.5 }, patioM: 2 }, SHORT, 0.1);
    const res = photoEdges(outline, raster);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const east = res.edges.find((e) => e.edge === 1)!;
    if (east.status === 'moved') expect(east.offsetM).toBeLessThanOrEqual(1.2);
    expect(Math.max(...res.outline.map((p) => p.x))).toBeLessThanOrEqual(21.25);
  });

  for (const turn of [90, 30]) {
    it(`gives the same move when the scene is turned ${turn} degrees (metamorphic)`, () => {
      const base = photoEdges(...pair(render({ roof: ROOF, crown: { x: 20, y: -16, r: 4, leaves: 0.5 } }, SHORT, 0.1)));
      const turned = photoEdges(...pair(render({ roof: ROOF, crown: { x: 20, y: -16, r: 4, leaves: 0.5 } }, SHORT, 0.1, turn)));
      expect(base.ok && turned.ok).toBe(true);
      if (!base.ok || !turned.ok) return;
      const a = base.edges.find((e) => e.edge === 1)!;
      const b = turned.edges.find((e) => e.edge === 1)!;
      expect(b.status).toBe(a.status);
      expect(Math.abs(b.offsetM - a.offsetM)).toBeLessThanOrEqual(turn === 90 ? 0.1 : 0.2);
      expect(Math.abs(areaOf(turned.outline) - areaOf(base.outline))).toBeLessThan(0.05 * areaOf(base.outline));
    });
  }

  it('gives the same move at 0.1 and 0.25 m pixels (metamorphic: pixel size)', () => {
    const fine = photoEdges(...pair(render({ roof: ROOF, crown: { x: 20, y: -16, r: 4, leaves: 0.5 } }, SHORT, 0.1)));
    const coarse = photoEdges(...pair(render({ roof: ROOF, crown: { x: 20, y: -16, r: 4, leaves: 0.5 } }, SHORT, 0.25)));
    expect(fine.ok && coarse.ok).toBe(true);
    if (!fine.ok || !coarse.ok) return;
    expect(Math.abs(fine.edges[1]!.offsetM - coarse.edges[1]!.offsetM)).toBeLessThanOrEqual(0.3);
  });

  it('moves eaves hidden at several positions and crown sizes, and never the visible ones', () => {
    for (const [cy, r] of [
      [-20, 3],
      [-12, 3.5],
      [-16, 5],
    ] as const) {
      const { raster, outline } = render({ roof: ROOF, crown: { x: 20, y: cy, r, leaves: 0.45 } }, SHORT, 0.1, 0, 5);
      const res = photoEdges(outline, raster);
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      for (const e of res.edges) if (e.edge !== 1) expect(e.status).not.toBe('moved');
      const east = res.edges[1]!;
      if (east.status === 'moved') expect(Math.abs(east.offsetM - 1)).toBeLessThanOrEqual(0.25);
    }
  });

  it('is deterministic: identical input, byte-identical output', () => {
    const run = () => JSON.stringify(photoEdges(...pair(render({ roof: ROOF, crown: { x: 20, y: -16, r: 4, leaves: 0.5 } }, SHORT, 0.1))));
    expect(run()).toBe(run());
  });

  it('returns a typed reason instead of throwing on bad input', () => {
    const { raster } = render({ roof: ROOF }, CORRECT, 0.25);
    expect(photoEdges([{ x: 1, y: -1 }], raster)).toEqual({ ok: false, reason: 'bad-outline' });
    expect(photoEdges(CORRECT, { ...raster, rgb: new Uint8Array(5) })).toEqual({ ok: false, reason: 'bad-raster' });
    expect(photoEdges([...CORRECT.slice(0, 2), { x: Number.NaN, y: 0 }], raster)).toEqual({ ok: false, reason: 'bad-outline' });
    expect(photoEdges(CORRECT, { ...raster, width: 0 })).toEqual({ ok: false, reason: 'bad-raster' });
  });

  it('keeps its constants within principled ranges', () => {
    expect(DEFAULT_PHOTO_EDGE.searchOutM).toBeGreaterThan(DEFAULT_PHOTO_EDGE.searchInM);
    expect(DEFAULT_PHOTO_EDGE.minContrast).toBeGreaterThan(0);
    expect(DEFAULT_PHOTO_EDGE.minContrast).toBeLessThan(1);
  });
});

describe('reconstructRoof with hiddenEdge: photo', () => {
  /** A whole raster for the reconstruction: the photo scene plus heights, with the mask short under the crown. */
  function sceneRaster(s: number, crown = true) {
    const { raster } = render({ roof: ROOF, ...(crown ? { crown: { x: 20, y: -16, r: 4, leaves: 0.5 } } : {}) }, crown ? SHORT : CORRECT, s);
    return { width: raster.width, height: raster.height, pixelSizeM: s, dsm: raster.dsm, mask: raster.mask, rgb: raster.rgb };
  }
  const point = (s: number) => ({ col: 14 / s, row: 16 / s });

  for (const s of [0.1, 0.25]) {
    it(`is off by default and changes nothing then (${s} m pixels)`, () => {
      const r = sceneRaster(s);
      const off = reconstructRoof(r, point(s), { seed: 7 });
      const none = reconstructRoof({ ...r, rgb: null }, point(s), { seed: 7 });
      expect(JSON.stringify(off)).toBe(JSON.stringify(none));
      expect(off?.hiddenEdges).toBeUndefined();
    });

    it(`extends the roof to the eave the photo shows, and records it (${s} m pixels)`, () => {
      const r = sceneRaster(s);
      const off = reconstructRoof(r, point(s), { seed: 7 })!;
      const on = reconstructRoof(r, point(s), { seed: 7, hiddenEdge: { method: 'photo' } })!;
      expect(on).not.toBeNull();
      expect(on.hiddenEdges?.method).toBe('photo');
      const maxX = (ring: readonly XY[]) => Math.max(...ring.map((p) => p.x));
      // Truth: the roof ends at x = 20 + (34/2 - 16) = 21 in raster metres; the mask stops a metre short.
      expect(maxX(off.outline)).toBeLessThan(20.4);
      expect(Math.abs(maxX(on.outline) - 21)).toBeLessThanOrEqual(s <= 0.1 ? 0.25 : 0.35);
      expect(on.hiddenEdges!.moved.length).toBeGreaterThan(0);
      // The faces still tile the outline.
      const faceArea = on.faces.reduce((t, f) => t + f.planAreaM2, 0);
      expect(Math.abs(faceArea - areaOf(on.outline))).toBeLessThan(0.02 * areaOf(on.outline));
    });
  }

  it('declines with a typed reason when there is no photo', () => {
    const r = sceneRaster(0.1);
    const on = reconstructRoof({ ...r, rgb: null }, point(0.1), { seed: 7, hiddenEdge: { method: 'photo' } })!;
    expect(on.hiddenEdges?.declined).toBe('no-photo');
    const off = reconstructRoof({ ...r, rgb: null }, point(0.1), { seed: 7 })!;
    expect(on.outline).toEqual(off.outline);
  });

  it('is deterministic with the option on', () => {
    const r = sceneRaster(0.1);
    const a = JSON.stringify(reconstructRoof(r, point(0.1), { seed: 7, hiddenEdge: { method: 'photo' } }));
    const b = JSON.stringify(reconstructRoof(r, point(0.1), { seed: 7, hiddenEdge: { method: 'photo' } }));
    expect(a).toBe(b);
  });
});

function pair(x: { raster: PhotoEdgeRaster; outline: XY[] }): [XY[], PhotoEdgeRaster] {
  return [x.outline, x.raster];
}

function areaOf(ring: readonly XY[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
}

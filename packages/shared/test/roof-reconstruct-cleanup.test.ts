// Weak-face cleanup (faces-cleanup.ts): strips along the outline and steep faces without support are dissolved into
// their neighbours; real dormers stay; the faces still tile the roof.
import { describe, expect, it } from 'vitest';
import { DEFAULT_FACE_CLEANUP, type FaceSupport, weakFaces } from '../src/roof-reconstruct/faces-cleanup.ts';
import { reconstructRoof } from '../src/roof-reconstruct/index.ts';
import { DORMER_GABLE } from './fixtures/hard-roofs.ts';
import { GABLE, HIP, L_CROSS, PORCH, synthesize } from './fixtures/synthetic-roofs.ts';

const SQ_FT = 10.7639104167;

/** GABLE with both rakes bent down over their last `stripM` (a bargeboard, a gutter run or branches over the rake). */
function bentRakes(stripM: number, dropPerM: number): typeof GABLE {
  return {
    ...GABLE,
    name: `gable-bent-rakes-${stripM}`,
    height: (p) => {
      const h = GABLE.height(p);
      if (h === null) return null;
      const over = Math.abs(p.x) - (7 - stripM);
      return over > 0 ? h - over * dropPerM : h;
    },
  };
}

const face = (o: Partial<FaceSupport>): FaceSupport => ({
  widthM: 2,
  areaM2: 20,
  pitchX12: 6,
  planeShare: 0.95,
  minNeighbourDeg: 30,
  edgeShare: 0.1,
  thicknessM: 2,
  crownShare: 0,
  mainNeighbourX12: 6,
  ...o,
});

describe('weakFaces (pure rules)', () => {
  it('crown-edge: a small odd-pitched face along a crown-backed eave goes; real faces beside crowns stay', () => {
    const along = { areaM2: 10, pitchX12: 4.6, mainNeighbourX12: 8.5, edgeShare: 0.4, crownShare: 0.8 };
    expect([...weakFaces([face({ areaM2: 60 }), face(along)])]).toEqual([[1, 'crown-edge']]);
    // Each condition alone keeps it: no crown, too big, pitch close to its neighbour's, not on the edge, no neighbour.
    expect(weakFaces([face({ areaM2: 60 }), face({ ...along, crownShare: 0.3 })]).size).toBe(0);
    expect(weakFaces([face({ areaM2: 60 }), face({ ...along, areaM2: 16 })]).size).toBe(0);
    expect(weakFaces([face({ areaM2: 60 }), face({ ...along, pitchX12: 6 })]).size).toBe(0);
    expect(weakFaces([face({ areaM2: 60 }), face({ ...along, edgeShare: 0.1 })]).size).toBe(0);
    expect(weakFaces([face({ areaM2: 60 }), face({ ...along, mainNeighbourX12: null })]).size).toBe(0);
    // Off with the cleanup's parameters (crownShare above 1 never fires).
    expect(weakFaces([face({ areaM2: 60 }), face(along)], { ...DEFAULT_FACE_CLEANUP, crownShare: 1.01 }).size).toBe(0);
  });

  it('a thin strip on the outline goes, a thin face inside with its own plane stays', () => {
    const weak = weakFaces([face({}), face({ widthM: 0.7, areaM2: 3, edgeShare: 0.4 }), face({ widthM: 0.7, areaM2: 3, edgeShare: 0 })]);
    expect([...weak]).toEqual([[1, 'thin-edge']]);
  });
  it('a thin face on its neighbour plane goes wherever it is', () => {
    expect(weakFaces([face({}), face({ widthM: 0.6, areaM2: 4, minNeighbourDeg: 3 })]).get(1)).toBe('thin-coplanar');
  });
  it('steeper than 18/12 goes unless strongly supported and not thin', () => {
    expect(weakFaces([face({}), face({ pitchX12: 22, planeShare: 0.7 })]).get(1)).toBe('steep-unsupported');
    expect(weakFaces([face({}), face({ pitchX12: 22, planeShare: 0.95, widthM: 0.8, areaM2: 5 })]).get(1)).toBe('steep-unsupported');
    expect(weakFaces([face({}), face({ pitchX12: 22, planeShare: 0.95 })]).size).toBe(0);
  });
  it('big faces and lone faces never go; at least one face always stays', () => {
    expect(weakFaces([face({ widthM: 0.5, areaM2: 50, edgeShare: 0.9 })]).size).toBe(0);
    expect(weakFaces([face({ minNeighbourDeg: 180, widthM: 0.5, areaM2: 3, edgeShare: 1 })]).size).toBe(0);
    const all = weakFaces([face({ widthM: 0.5, areaM2: 3, edgeShare: 1, minNeighbourDeg: 2 }), face({ widthM: 0.5, areaM2: 4, edgeShare: 1, minNeighbourDeg: 2 })]);
    expect(all.size).toBe(1);
  });
  it('property: raising thinWidthM never makes fewer faces weak (monotone)', () => {
    for (let t = 0; t < 200; t++) {
      const r = (k: number) => ((t * 7919 + k * 104729) % 1000) / 1000;
      const fs = [face({}), face({ widthM: r(1) * 1.5, areaM2: r(2) * 15, edgeShare: r(3), minNeighbourDeg: r(4) * 40, pitchX12: r(5) * 24, planeShare: r(6) })];
      const a = weakFaces(fs, { ...DEFAULT_FACE_CLEANUP, thinWidthM: 0.7 }).size;
      const b = weakFaces(fs, { ...DEFAULT_FACE_CLEANUP, thinWidthM: 1.1 }).size;
      expect(b).toBeGreaterThanOrEqual(a);
    }
  });
});

describe('reconstructRoof with the cleanup', () => {
  // Regression guard only: the earlier rules already read this synthetic case right (the failing case is reproduced on
  // real dev houses by the benchmark: lr-305-ridgeway, lr-tyler; see docs/roof-3d/faces.md).
  it('a gable with bent rake strips reads as its two faces', () => {
    const syn = synthesize(bentRakes(0.7, 1.2), { turnDeg: 17, seed: 11, trees: 0 });
    const on = reconstructRoof(syn.raster, syn.point)!;
    expect(on.faces.length).toBe(2);
    for (const f of on.faces) expect(Math.abs(f.pitchX12 - 6)).toBeLessThan(0.5);
  });

  it('the dormer gable keeps its dormer (real small faces with their own plane stay)', () => {
    for (const turnDeg of [17, 30]) {
      const syn = synthesize(DORMER_GABLE, { turnDeg, seed: 11, trees: 0 });
      const r = reconstructRoof(syn.raster, syn.point)!;
      expect(r.faces.length).toBe(DORMER_GABLE.faces.length);
      expect(r.dissolved).toBeUndefined();
    }
  });

  it('invariants on every synthetic roof: faces tile the roof, none under 25 sq ft, nothing steeper than 18/12', () => {
    for (const shape of [GABLE, HIP, L_CROSS, PORCH, DORMER_GABLE, bentRakes(0.7, 1.2), bentRakes(0.5, 2)]) {
      for (const turnDeg of [0, 17, 41]) {
        const syn = synthesize(shape, { turnDeg, seed: 5 });
        const r = reconstructRoof(syn.raster, syn.point);
        expect(r, shape.name).not.toBeNull();
        const outline = Math.abs(r!.outline.reduce((t, p, i) => {
          const q = r!.outline[(i + 1) % r!.outline.length]!;
          return t + p.x * q.y - q.x * p.y;
        }, 0)) / 2;
        expect(Math.abs(r!.faces.reduce((t, f) => t + f.planAreaM2, 0) / outline - 1), shape.name).toBeLessThan(1e-6);
        for (const f of r!.faces) {
          expect(f.planAreaM2 * SQ_FT, `${shape.name} face area`).toBeGreaterThanOrEqual(25);
          expect(f.pitchX12, `${shape.name} pitch`).toBeLessThanOrEqual(18.5);
        }
      }
    }
  });
});

/**
 * A gable (6/12) with a tree crown leaning over 5 m of its south eave the way 305 Ridgeway Dr's does: Google's mask
 * runs on 1.6 m over the crown's smooth top, which falls away at 2/12, and the crown goes on, rough, beyond the mask.
 * The photo is green over the whole crown.
 */
function gableWithCrownSkirt(turnDeg: number) {
  const syn = synthesize(GABLE, { turnDeg, seed: 11, trees: 0, noiseM: 0.02 });
  const { width: W, height: H, pixelSizeM: s, dsm, mask } = syn.raster;
  const o = syn.toLocal({ x: 0, y: 0 });
  const ex = syn.toLocal({ x: 1, y: 0 });
  const ey = syn.toLocal({ x: 0, y: 1 });
  const ax = { x: ex.x - o.x, y: ex.y - o.y };
  const ay = { x: ey.x - o.x, y: ey.y - o.y };
  const green = new Uint8Array(W * H);
  let k = 7;
  const noise = () => {
    k = (k * 1103515245 + 12345) % 2147483648;
    return k / 2147483648 - 0.5;
  };
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const lx = (c + 0.5) * s - o.x;
      const ly = -(r + 0.5) * s - o.y;
      const hx = lx * ax.x + ly * ax.y;
      const hy = lx * ay.x + ly * ay.y;
      if (Math.abs(hx) > 2.5 || hy > -4.5 || hy < -8.5) continue;
      const i = r * W + c;
      green[i] = 1;
      if (hy >= -6.1) {
        // The crown's smooth top Google took for roof: on from the eave (3 m) at 2/12.
        mask[i] = 1;
        dsm[i] = 3 - (-4.5 - hy) * (2 / 12) + noise() * 0.02;
      } else {
        // The rest of the crown, rough, off the mask.
        dsm[i] = 2.8 + noise() * 0.5;
      }
    }
  }
  return { syn, raster: { ...syn.raster, dsm, mask, green } };
}

describe('crown-edge: no face drawn from foliage over the eave', () => {
  for (const turnDeg of [0, 23]) {
    it(`gable turned ${turnDeg} deg with a crown skirt on one eave keeps its two faces and pitches`, () => {
      const { syn, raster } = gableWithCrownSkirt(turnDeg);
      const on = reconstructRoof(raster, syn.point, { seed: 7 });
      expect(on).not.toBeNull();
      expect(on!.faces.length).toBe(2);
      for (const f of on!.faces) expect(Math.abs(f.pitchX12 - 6)).toBeLessThan(0.5);
      expect(on!.dissolved?.['crown-edge']).toBe(1);
      // Without the rule, the skirt is a 2/12 face of its own (the failure on the owner's screenshot).
      const off = reconstructRoof(raster, syn.point, { seed: 7, faces: { crownShare: 1.01 } });
      expect(off!.faces.length).toBe(3);
      expect(off!.faces.some((f) => f.pitchX12 < 3)).toBe(true);
    });
  }

  it('a real small face beside a crown with its neighbour\'s pitch stays (porch, same pitch)', () => {
    const syn = synthesize(PORCH, { turnDeg: 23, seed: 11, trees: 0 });
    const r = reconstructRoof(syn.raster, syn.point, { seed: 7 });
    expect(r!.dissolved?.['crown-edge'] ?? 0).toBe(0);
  });
});

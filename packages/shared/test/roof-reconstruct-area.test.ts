import { describe, expect, it } from 'vitest';
import { type AreaParams, type AreaPhoto, DEFAULT_AREA_PARAMS, eaveDropShare, eaveMoves, moveEdges, roofEndInPhoto, trimmedPoint, trimRoof, tuckUnder } from '../src/roof-reconstruct/area.ts';
import { selfIntersects, signedArea, type XY } from '../src/roof-reconstruct/geom.ts';
import { reconstructRoof, type RoofRaster } from '../src/roof-reconstruct/index.ts';
import { GABLE, PORCH, type SyntheticRoof, synthesize, TWO_STOREY } from './fixtures/synthetic-roofs.ts';

// Area at the roof's edges (area.ts): eaves moved in to where the photo shows the roof ending (the mask runs fat), a
// fixed inset where the photo says nothing, and the roof a lower face has under the overhang of the roof above it.

const ROOF_RGB = [96, 100, 112] as const;
const WALL_RGB = [232, 228, 220] as const;
const YARD_RGB = [70, 110, 60] as const;

/** A photo on a W x H grid of s metres a pixel: `colour(x, y)` at each pixel's centre (x east, y north, y <= 0). */
function paint(W: number, H: number, s: number, colour: (x: number, y: number) => readonly [number, number, number]): Uint8Array {
  const rgb = new Uint8Array(3 * W * H);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) rgb.set(colour((c + 0.5) * s, -(r + 0.5) * s), 3 * (r * W + c));
  }
  return rgb;
}

/** A photo whose roof colour ends at x = roofEndX, with a bright band (a sunlit wall) from there to x = bandEndX, then yard. */
function bandPhoto(roofEndX: number, bandEndX: number): AreaPhoto {
  const W = 300;
  const H = 200;
  return { rgb: paint(W, H, 0.1, (x) => (x < roofEndX ? ROOF_RGB : x < bandEndX ? WALL_RGB : YARD_RGB)), green: null, width: W, height: H, c0: 0, r0: 0 };
}

const P: AreaParams = { ...DEFAULT_AREA_PARAMS, eavePhoto: true };
// An outline edge at x = 20 running north to south down the photo's middle, the roof to its west: outward normal east.
const A: XY = { x: 20, y: -4 };
const B: XY = { x: 20, y: -16 };
const EAST: XY = { x: 1, y: 0 };

describe('roofEndInPhoto: where the photo shows the roof ending across an outline edge', () => {
  it('finds the half-way point of the colour change inside a fat edge (a bright band of wall between roof and mask edge)', () => {
    const seen = roofEndInPhoto(A, B, EAST, 0.1, bandPhoto(19.6, 20), P);
    expect(seen.atM).not.toBeNull();
    expect(seen.atM!).toBeGreaterThan(-0.5);
    expect(seen.atM!).toBeLessThan(-0.3);
    expect(seen.canopy).toBe(false);
  });

  it('puts the end at the edge when the roof colour runs right up to it', () => {
    const seen = roofEndInPhoto(A, B, EAST, 0.1, bandPhoto(20, 20), P);
    expect(seen.atM).not.toBeNull();
    expect(Math.abs(seen.atM!)).toBeLessThan(0.1);
  });

  it('says nothing when the photo shows no change in reach (a dark roof beside its own shadow)', () => {
    expect(roofEndInPhoto(A, B, EAST, 0.1, bandPhoto(25, 25), P).atM).toBeNull();
  });

  it('declines a change deeper inside the roof than the mask can be fat (a band of other roofing along the eave)', () => {
    expect(roofEndInPhoto(A, B, EAST, 0.1, bandPhoto(19.25, 20), P).atM).toBeNull();
    expect(roofEndInPhoto(A, B, EAST, 0.1, bandPhoto(18.9, 20), P).atM).toBeNull();
  });

  it('marks an edge with leaves just outside it as under a crown', () => {
    const photo = bandPhoto(20, 20);
    const green = new Uint8Array(photo.width * photo.height);
    for (let r = 0; r < photo.height; r++) for (let c = 200; c < photo.width; c++) green[r * photo.width + c] = 1;
    const seen = roofEndInPhoto(A, B, EAST, 0.1, { ...photo, green }, P);
    expect(seen.canopy).toBe(true);
    expect(seen.atM).toBeNull();
  });
});

describe('moveEdges: an outline with each edge moved along its normal', () => {
  const square: XY[] = [
    { x: 0, y: -10 },
    { x: 10, y: -10 },
    { x: 10, y: 0 },
    { x: 0, y: 0 },
  ];

  it('moves each edge by its own amount and re-meets the corners', () => {
    // Counter-clockwise from the south-west: south edge 0, east edge 0.4 in, north edge 0.1 in, west edge 0.
    const out = moveEdges(square, [0, -0.4, -0.1, 0])!;
    expect(out).not.toBeNull();
    expect(out[0]!.x).toBeCloseTo(0, 6);
    expect(out[1]!.x).toBeCloseTo(9.6, 6);
    expect(out[1]!.y).toBeCloseTo(-10, 6);
    expect(out[2]!.x).toBeCloseTo(9.6, 6);
    expect(out[2]!.y).toBeCloseTo(-0.1, 6);
    expect(out[3]!.y).toBeCloseTo(-0.1, 6);
    expect(signedArea(out)).toBeCloseTo(9.6 * 9.9, 6);
  });

  it('works the same on a clockwise ring', () => {
    const out = moveEdges([...square].reverse(), [-0.1, -0.4, 0, 0])!;
    expect(Math.abs(signedArea(out))).toBeCloseTo(9.6 * 9.9, 6);
  });

  it('keeps a short jog between two edges moved by different amounts the right way round', () => {
    // An east side with a 0.2 m jog: the edge above the jog moves in 0.5 m, the edge below it stays.
    const jog: XY[] = [
      { x: 0, y: -10 },
      { x: 10, y: -10 },
      { x: 10, y: -5 },
      { x: 10.2, y: -5 },
      { x: 10.2, y: 0 },
      { x: 0, y: 0 },
    ];
    const out = moveEdges(jog, [0, 0, 0, -0.5, 0, 0]);
    expect(out).not.toBeNull();
    expect(selfIntersects(out!)).toBe(false);
    expect(Math.abs(signedArea(out!))).toBeLessThan(Math.abs(signedArea(jog)));
    expect(Math.abs(signedArea(out!))).toBeGreaterThan(Math.abs(signedArea(jog)) - 3);
  });
});

describe('eaveDropShare: an edge is an eave where the heights fall across it', () => {
  const W = 300;
  const H = 200;
  const heights = (outside: number) => {
    const dsm = new Float32Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) dsm[r * W + c] = (c + 0.5) * 0.1 < 20 ? 6 : outside;
    return { dsm, w: W, h: H };
  };

  it('is 1 along a roof edge over the yard, 0 beside a wall as high as the roof or a crown over the eave', () => {
    expect(eaveDropShare(A, B, EAST, 0.1, heights(0), 1)).toBe(1);
    expect(eaveDropShare(A, B, EAST, 0.1, heights(6.2), 1)).toBe(0);
    expect(eaveDropShare(A, B, EAST, 0.1, heights(9), 1)).toBe(0);
  });
});

describe('eaveMoves: how far each outline edge moves', () => {
  const ring: XY[] = [
    { x: 6, y: -16 },
    { x: 20, y: -16 },
    { x: 20, y: -4 },
    { x: 6, y: -4 },
  ];
  const W = 300;
  const H = 200;
  const dsm = new Float32Array(W * H);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const x = (c + 0.5) * 0.1;
      const y = -(r + 0.5) * 0.1;
      // The roof, 6 m up; yard all round, but a taller block against its north side.
      dsm[r * W + c] = x > 6 && x < 20 && y > -16 && y < -4 ? 6 : y >= -4 && y < -1 && x > 6 && x < 20 ? 9 : 0;
    }
  }
  const heights = { dsm, w: W, h: H };
  // The roof colour ends 0.4 m short of the east edge; the west and south edges show no colour change at all.
  const photo: AreaPhoto = { rgb: paint(W, H, 0.1, (x) => (x < 19.6 ? ROOF_RGB : x < 20 ? WALL_RGB : YARD_RGB)), green: null, width: W, height: H, c0: 0, r0: 0 };
  const dark: AreaPhoto = { ...photo, rgb: paint(W, H, 0.1, () => ROOF_RGB) };

  it('moves an edge in to the photo, by the inset where the photo is silent, and not at all without an eave in the heights', () => {
    const moves = eaveMoves(ring, 0.1, photo, heights, { ...P, eaveInsetM: 0.1 });
    // Edge 1 is the east side: the photo's colour change, 0.4 m in.
    expect(moves[1]!.by).toBe('photo');
    expect(moves[1]!.moveM).toBeLessThan(-0.3);
    expect(moves[1]!.moveM).toBeGreaterThan(-0.5);
    // Edge 2 is the north side: a taller block beside it, no eave drop: it stays.
    expect(moves[2]!.by).toBe('none');
    expect(moves[2]!.moveM).toBe(0);
    const silent = eaveMoves(ring, 0.1, dark, heights, { ...P, eaveInsetM: 0.1 });
    expect(silent[0]!.by).toBe('inset');
    expect(silent[0]!.moveM).toBeCloseTo(-0.1, 9);
    expect(silent[3]!.moveM).toBeCloseTo(-0.1, 9);
  });

  it('does nothing when both the photo and the inset are off, and only the inset without a photo', () => {
    expect(eaveMoves(ring, 0.1, photo, heights, { ...P, eavePhoto: false, eaveInsetM: 0 })).toEqual([]);
    const noPhoto = eaveMoves(ring, 0.1, null, heights, { ...P, eaveInsetM: 0.1 });
    expect(noPhoto.map((e) => e.by)).toEqual(['inset', 'inset', 'none', 'inset']);
    expect(eaveMoves(ring, 0.1, null, heights, P).every((e) => e.moveM === 0)).toBe(true);
    expect(eaveMoves(ring, 0.1, photo, heights, DEFAULT_AREA_PARAMS)).toEqual([]);
  });
});

describe('trimRoof: the trim on a finished roof moves its edge, not its faces', () => {
  const outline: XY[] = [
    { x: 6, y: -16 },
    { x: 20, y: -16 },
    { x: 20, y: -4 },
    { x: 6, y: -4 },
  ];
  // Two faces either side of a ridge along y = -10, and their lines.
  const faces = [
    { ring: [outline[0]!, outline[1]!, { x: 20, y: -10 }, { x: 6, y: -10 }], areaM2: 84, fromPixels: false },
    { ring: [{ x: 6, y: -10 }, { x: 20, y: -10 }, outline[2]!, outline[3]!], areaM2: 84, fromPixels: false },
  ];
  const lines = [
    { kind: 'ridge', a: { x: 6, y: -10 }, b: { x: 20, y: -10 }, faces: [0, 1], lengthM: 14, riseM: 0 },
    { kind: 'rake', a: { x: 20, y: -16 }, b: { x: 20, y: -10 }, faces: [0], lengthM: Math.hypot(6, 3), riseM: 3 },
    { kind: 'eave', a: { x: 6, y: -16 }, b: { x: 20, y: -16 }, faces: [0], lengthM: 14, riseM: 0 },
  ];
  const W = 300;
  const H = 200;
  const dsm = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) dsm[r * W + c] = (c + 0.5) * 0.1 > 6 && (c + 0.5) * 0.1 < 20 && -(r + 0.5) * 0.1 > -16 && -(r + 0.5) * 0.1 < -4 ? 6 : 0;
  const photo: AreaPhoto = { rgb: paint(W, H, 0.1, (x, y) => (x > 6 && x < 19.6 && y > -16 && y < -4 ? ROOF_RGB : x >= 19.6 && x < 20 && y > -16 && y < -4 ? WALL_RGB : YARD_RGB)), green: null, width: W, height: H, c0: 0, r0: 0 };

  it('moves the east edge in with the ridge end, the rake and the faces that end on it', () => {
    const out = trimRoof(outline, 0.1, photo, { dsm, w: W, h: H }, P, faces, lines, { tinyFaceM2: 2.35, thinFaceM: 0.9 })!;
    expect(out).not.toBeNull();
    const east = Math.max(...out.outline.map((p) => p.x));
    expect(east).toBeGreaterThan(19.5);
    expect(east).toBeLessThan(19.7);
    expect(out.faces).toHaveLength(2);
    expect(out.lines).toHaveLength(3);
    // The faces tile the trimmed outline; each lost the strip along the east edge.
    expect(out.faces[0]!.areaM2 + out.faces[1]!.areaM2).toBeCloseTo(Math.abs(signedArea(out.outline)), 6);
    expect(out.faces[0]!.areaM2).toBeCloseTo(84 - 6 * (20 - east), 6);
    const ridge = out.lines[0]!;
    expect(ridge.b.x).toBeCloseTo(east, 6);
    expect(ridge.lengthM).toBeCloseTo(east - 6, 6);
    // The rake moved sideways: the same length and rise.
    expect(out.lines[1]!.a.x).toBeCloseTo(east, 6);
    expect(out.lines[1]!.lengthM).toBeCloseTo(Math.hypot(6, 3), 6);
    expect(out.lines[2]!.lengthM).toBeCloseTo(east - 6, 6);
  });

  it('leaves an edge where it is when the trim would turn a face on it into a sliver', () => {
    // A strip 1.2 m wide along the east edge is a face of its own: 0.4 m off it would leave it under 0.9 m wide.
    const strip = [
      { ring: [outline[0]!, { x: 18.8, y: -16 }, { x: 18.8, y: -4 }, outline[3]!], areaM2: 12.8 * 12, fromPixels: false },
      { ring: [{ x: 18.8, y: -16 }, outline[1]!, outline[2]!, { x: 18.8, y: -4 }], areaM2: 1.2 * 12, fromPixels: false },
    ];
    const out = trimRoof(outline, 0.1, photo, { dsm, w: W, h: H }, P, strip, [], { tinyFaceM2: 2.35, thinFaceM: 0.9 });
    expect(out === null || Math.max(...out.outline.map((p) => p.x)) > 19.99).toBe(true);
  });

  it('trimmedPoint moves corners to corners and leaves the inside alone', () => {
    const now = moveEdges(outline, [0, -0.4, 0, 0])!;
    const at = trimmedPoint(outline, now);
    expect(at(outline[1]!)).toEqual(now[1]);
    expect(at({ x: 20, y: -10 }).x).toBeCloseTo(19.6, 9);
    expect(at({ x: 12, y: -9 })).toEqual({ x: 12, y: -9 });
    // A point the trim left outside comes onto the new outline.
    expect(at({ x: 19.9, y: -9 }).x).toBeCloseTo(19.6, 9);
  });
});

describe('tuckUnder: the roof a lower face has under the overhang of the roof above it', () => {
  it('adds each wall line length times the overhang depth to the lower face, and nothing for other lines', () => {
    const lines = [
      { kind: 'flashing', a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, faces: [2] },
      { kind: 'step-flashing', a: { x: 0, y: 0 }, b: { x: 0, y: -4 }, faces: [2] },
      { kind: 'step-flashing', a: { x: 5, y: 0 }, b: { x: 5, y: -3 }, faces: [1] },
      { kind: 'eave', a: { x: 0, y: -4 }, b: { x: 10, y: -4 }, faces: [2] },
      { kind: 'valley', a: { x: 0, y: 0 }, b: { x: 3, y: 3 }, faces: [0, 1] },
    ];
    expect(tuckUnder(lines, 3, { ...P, tuckUnderM: 0.3 })).toEqual([0, 3 * 0.3, 14 * 0.3]);
    expect(tuckUnder(lines, 3, P)).toEqual([0, 0, 0]);
  });
});

/** The synthetic roof's raster with a photo: roof colour where `isRoof` (house frame), a bright wall band on the rest of the mask, yard elsewhere. */
function withPhoto(syn: SyntheticRoof, isRoof: (p: XY) => boolean): RoofRaster {
  const { width: W, height: H, pixelSizeM: s, mask } = syn.raster;
  const o = syn.toLocal({ x: 0, y: 0 });
  const ex = syn.toLocal({ x: 1, y: 0 });
  const ey = syn.toLocal({ x: 0, y: 1 });
  const toHouse = (x: number, y: number): XY => ({ x: (x - o.x) * (ex.x - o.x) + (y - o.y) * (ex.y - o.y), y: (x - o.x) * (ey.x - o.x) + (y - o.y) * (ey.y - o.y) });
  const rgb = paint(W, H, s, (x, y) => {
    const c = Math.floor(x / s);
    const r = Math.floor(-y / s);
    if (mask[r * W + c] !== 1) return YARD_RGB;
    return isRoof(toHouse(x, y)) ? ROOF_RGB : WALL_RGB;
  });
  return { ...syn.raster, rgb };
}

const outlineArea = (ring: readonly XY[]) => Math.abs(signedArea(ring));

describe('reconstructRoof: area at the roof edges', () => {
  it('moves a fat gable end in to where the photo shows the roof ending, and the ridge and eaves with it', () => {
    const syn = synthesize(GABLE, { trees: 0 });
    // The roof truly ends 0.4 m short of the mask at its east gable end: a bright band of wall is in the mask there.
    const raster = withPhoto(syn, (p) => p.x < 7 - 0.4);
    const off = reconstructRoof(raster, syn.point)!;
    const on = reconstructRoof(raster, syn.point, { area: { eavePhoto: true } })!;
    expect(off.eaveTrim).toBeUndefined();
    expect(on.eaveTrim).toBeDefined();
    // 0.4 m off a 9 m gable end.
    expect(outlineArea(off.outline) - outlineArea(on.outline)).toBeGreaterThan(0.3 * 9);
    expect(outlineArea(off.outline) - outlineArea(on.outline)).toBeLessThan(0.5 * 9);
    expect(on.faces.reduce((t, f) => t + f.planAreaM2, 0)).toBeCloseTo(outlineArea(on.outline), 6);
    const ridge = (r: typeof on) => r.lines.filter((l) => l.kind === 'ridge').reduce((t, l) => t + l.lengthM, 0);
    expect(ridge(off) - ridge(on)).toBeGreaterThan(0.3);
    expect(ridge(off) - ridge(on)).toBeLessThan(0.5);
    expect(on.faces).toHaveLength(off.faces.length);
    // The mask the outline is checked against loses the rim too: the roof is not marked for it.
    expect(on.quality.reasons).not.toContain('outline-off');
    expect(on.quality.reasons).not.toContain('faces-patchy');
  });

  it('gives the same roof trimming before the topology or after it', () => {
    const syn = synthesize(GABLE, { trees: 0 });
    const raster = withPhoto(syn, (p) => p.x < 7 - 0.4);
    const before = reconstructRoof(raster, syn.point, { area: { eavePhoto: true, eaveBeforeTopology: true } })!;
    const after = reconstructRoof(raster, syn.point, { area: { eavePhoto: true, eaveBeforeTopology: false } })!;
    expect(Math.abs(outlineArea(before.outline) - outlineArea(after.outline))).toBeLessThan(0.05);
    expect(after.faces).toHaveLength(before.faces.length);
    expect(Math.abs(after.faces[0]!.planAreaM2 - before.faces[0]!.planAreaM2)).toBeLessThan(0.3);
  });

  it('leaves a roof whose colour runs to the mask edge alone, and without a photo moves nothing unless the inset is set', () => {
    const syn = synthesize(GABLE, { trees: 0 });
    const exact = reconstructRoof(withPhoto(syn, () => true), syn.point, { area: { eavePhoto: true } })!;
    const plain = reconstructRoof(syn.raster, syn.point)!;
    expect(plain.eaveTrim).toBeUndefined();
    expect(outlineArea(plain.outline) - outlineArea(exact.outline)).toBeLessThan(0.02 * outlineArea(plain.outline));
    const inset = reconstructRoof(syn.raster, syn.point, { area: { eaveInsetM: 0.1 } })!;
    // 0.1 m off each side of a 14 x 9 m roof: about 4.6 m2.
    expect(outlineArea(plain.outline) - outlineArea(inset.outline)).toBeGreaterThan(3.5);
    expect(outlineArea(plain.outline) - outlineArea(inset.outline)).toBeLessThan(5.5);
    expect(inset.eaveTrim!.every((e) => e.by === 'inset')).toBe(true);
  });

  it('adds the roof under the upper storey overhang to a porch roof and to a lower wing, only when asked', () => {
    for (const [shape, wallM] of [
      [PORCH, 10],
      [TWO_STOREY, 10],
    ] as const) {
      const syn = synthesize(shape, { trees: 0 });
      const off = reconstructRoof(syn.raster, syn.point)!;
      const on = reconstructRoof(syn.raster, syn.point, { area: { tuckUnderM: 0.3 } })!;
      expect(off.faces.every((f) => f.underOverhangM2 === undefined)).toBe(true);
      const sum = (r: typeof on) => r.faces.reduce((t, f) => t + f.planAreaM2, 0);
      expect(sum(off)).toBeCloseTo(outlineArea(off.outline), 6);
      const tucked = on.faces.reduce((t, f) => t + (f.underOverhangM2 ?? 0), 0);
      // The wall line's plan length (10 m in both shapes) times 0.3 m, within the line's own tolerance.
      expect(tucked).toBeGreaterThan(0.8 * wallM * 0.3);
      expect(tucked).toBeLessThan(1.2 * wallM * 0.3);
      expect(sum(on) - sum(off)).toBeCloseTo(tucked, 6);
      // Only faces with a wall line have any, and their sloped area grows at their own pitch.
      const walled = new Set(on.lines.filter((l) => l.kind === 'flashing' || l.kind === 'step-flashing').map((l) => l.faces[0]));
      on.faces.forEach((f, k) => expect(f.underOverhangM2 !== undefined).toBe(walled.has(k)));
      // The lines are the same either way.
      expect(on.lines.map((l) => [l.kind, l.lengthM])).toEqual(off.lines.map((l) => [l.kind, l.lengthM]));
    }
  });
});

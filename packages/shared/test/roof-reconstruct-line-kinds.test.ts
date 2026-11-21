import { describe, expect, it } from 'vitest';
import { reconstructRoof } from '../src/roof-reconstruct/index.ts';
import type { Plane } from '../src/roof-reconstruct/planes.ts';
import { buildTopology, DEFAULT_TOPOLOGY_PARAMS, type LineFeatures, type RoofLineKind3d, type TopoLine, type TopologyParams } from '../src/roof-reconstruct/topology.ts';
import { gableShape, HIP, hipShape, L_CROSS, PORCH, type Shape, synthesize, TWO_STOREY, type XY } from './fixtures/synthetic-roofs.ts';

// Line kinds checked against the height map beside the line (topology.ts: measuredEdge, measuredRidge, valleyDropM,
// hipStepM). Each roof here is a synthetic height map with a segmentation that makes the mistake the rule is for (the
// faces and planes are the test's input, as the plane search could have left them): the planes alone name the line
// wrong, the height map beside it names it right. Every test also runs with its rule off and sees the old name.

type Segmentation = {
  /** The roof's outline in the house frame, counter-clockwise. */
  outline: XY[];
  /** Which face a house-frame point on the roof belongs to. */
  faceOf: (p: XY) => number;
  /** The faces' planes in the house frame: z = a x + b y + c. */
  planes: Plane[];
};

function topologyOf(shape: Shape, seg: Segmentation, prm: Partial<TopologyParams> = {}, collect?: LineFeatures[]) {
  const syn = synthesize(shape, { turnDeg: 0, seed: 11, trees: 0 });
  const { width: w, height: h, pixelSizeM: s, dsm, mask } = syn.raster;
  const o = syn.toLocal({ x: 0, y: 0 });
  const labels = new Int32Array(w * h).fill(-1);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (mask[r * w + c] === 1) labels[r * w + c] = seg.faceOf({ x: (c + 0.5) * s - o.x, y: -(r + 0.5) * s - o.y });
    }
  }
  const planes = seg.planes.map((p) => ({ a: p.a, b: p.b, c: p.c - p.a * o.x - p.b * o.y }));
  const topo = buildTopology({ w, h }, s, labels, planes, seg.outline.map(syn.toLocal), dsm, { ...DEFAULT_TOPOLOGY_PARAMS, ...prm }, undefined, collect);
  /** The line of one of `kinds` whose middle is nearest a house-frame point. */
  const near = (p: XY, kinds: readonly RoofLineKind3d[] = ['ridge', 'hip', 'valley', 'eave', 'rake']): TopoLine => {
    const q = syn.toLocal(p);
    let best: TopoLine | null = null;
    let bd = Infinity;
    for (const l of topo.lines) {
      if (!kinds.includes(l.kind)) continue;
      const d = Math.hypot((l.a.x + l.b.x) / 2 - q.x, (l.a.y + l.b.y) / 2 - q.y);
      if (d < bd) {
        bd = d;
        best = l;
      }
    }
    if (best === null) throw new Error('no line');
    return best;
  };
  const total = (kind: RoofLineKind3d): number => topo.lines.filter((l) => l.kind === kind).reduce((t, l) => t + l.lengthM, 0);
  return { topo, near, total };
}

const rect = (halfX: number, halfY: number): XY[] => [
  { x: -halfX, y: -halfY },
  { x: halfX, y: -halfY },
  { x: halfX, y: halfY },
  { x: -halfX, y: halfY },
];

/** A roof 10 x 8 m of two halves that meet along y = 0, each half's height given. */
function halves(name: string, north: (p: XY) => number, south: (p: XY) => number): Shape {
  return {
    name,
    extent: 8,
    height: (p) => (Math.abs(p.x) > 5 || Math.abs(p.y) > 4 ? null : p.y >= 0 ? north(p) : south(p)),
    faces: [],
    lines: {},
    planAreaM2: 80,
  };
}

describe('a face edge is named by the roof that is really beside it (measuredEdge)', () => {
  // A hip roof 14 x 8 m at 8/12 whose two hip ends the planes missed: the segmentation has the two long slopes only,
  // each running to the ends of the house. Their planes say the end walls' edges climb the slope (rakes); the height
  // map climbs away from those edges and is level along them (the hip ends' eaves).
  const p = 8 / 12;
  const mergedHipEnds: Segmentation = {
    outline: rect(7, 4),
    faceOf: ({ y }) => (y >= 0 ? 0 : 1),
    planes: [
      { a: 0, b: -p, c: 3 + 4 * p },
      { a: 0, b: p, c: 3 + 4 * p },
    ],
  };

  it('the eave of a hip end merged into the main slopes is an eave, not a rake', () => {
    const on = topologyOf(hipShape(14, 8, 8), mergedHipEnds);
    for (const at of [{ x: 7, y: 2 }, { x: 7, y: -2 }, { x: -7, y: 2 }, { x: -7, y: -2 }]) expect(on.near(at).kind, `end at ${at.x},${at.y}`).toBe('eave');
    expect(on.near({ x: 0, y: 4 }).kind).toBe('eave');
    expect(on.total('rake')).toBeLessThan(1);
    // The planes alone (the rule off) call the four half ends rakes.
    const off = topologyOf(hipShape(14, 8, 8), mergedHipEnds, { measuredEdge: false });
    for (const at of [{ x: 7, y: 2 }, { x: -7, y: -2 }]) expect(off.near(at).kind).toBe('rake');
    expect(off.total('rake')).toBeGreaterThan(17);
  });

  it('the rake of a gable the planes took for one slope is a rake, and its eaves are eaves', () => {
    // A gable 10 x 8 m at 8/12 (ridge along X) under ONE face whose plane falls to the east: by that plane the east and
    // west edges are level (eaves) and the north and south edges climb (rakes), the wrong way round.
    const oneSlope: Segmentation = { outline: rect(5, 4), faceOf: () => 0, planes: [{ a: -0.4, b: 0, c: 5 }] };
    const on = topologyOf(gableShape(10, 8, 8), oneSlope);
    expect(on.near({ x: 5, y: 0 }).kind).toBe('rake');
    expect(on.near({ x: -5, y: 0 }).kind).toBe('rake');
    expect(on.near({ x: 0, y: 4 }).kind).toBe('eave');
    expect(on.near({ x: 0, y: -4 }).kind).toBe('eave');
    const off = topologyOf(gableShape(10, 8, 8), oneSlope, { measuredEdge: false });
    expect(off.near({ x: 5, y: 0 }).kind).toBe('eave');
    expect(off.near({ x: 0, y: 4 }).kind).toBe('rake');
  });

  it('leaves a true gable and a true hip roof as their planes name them', () => {
    const gable: Segmentation = {
      outline: rect(5, 4),
      faceOf: ({ y }) => (y >= 0 ? 0 : 1),
      planes: [
        { a: 0, b: -p, c: 3 + 4 * p },
        { a: 0, b: p, c: 3 + 4 * p },
      ],
    };
    const on = topologyOf(gableShape(10, 8, 8), gable);
    const off = topologyOf(gableShape(10, 8, 8), gable, { measuredEdge: false, measuredRidge: false, valleyDropM: 0, hipStepM: 0 });
    for (const kind of ['ridge', 'eave', 'rake'] as const) expect(on.total(kind), kind).toBeCloseTo(off.total(kind), 6);
    expect(on.total('eave')).toBeGreaterThan(19);
    expect(on.total('rake')).toBeGreaterThan(18);
  });
});

describe('a line the height map falls away from on both sides is a ridge (measuredRidge)', () => {
  it('a ridge under a face whose plane comes down to it is a ridge, not that face\'s eave', () => {
    // A gable 10 x 8 m at 6/12. The south face has its own plane; the north face's plane rises to the north (the
    // segmentation's mistake: its pixels lie on roof that falls to the north). By the planes the north face drains onto
    // the south one along the ridge line: an eave. The height map falls away on both sides.
    const seg: Segmentation = {
      outline: rect(5, 4),
      faceOf: ({ y }) => (y >= 0 ? 0 : 1),
      planes: [
        { a: 0, b: 1, c: 5 },
        { a: 0, b: 0.5, c: 5 },
      ],
    };
    const on = topologyOf(gableShape(10, 8, 6), seg);
    expect(on.near({ x: 0, y: 0 }).kind).toBe('ridge');
    expect(on.total('ridge')).toBeGreaterThan(9);
    const off = topologyOf(gableShape(10, 8, 6), seg, { measuredRidge: false });
    expect(off.near({ x: 0, y: 0 }).kind).toBe('eave');
    expect(off.total('ridge')).toBeLessThan(1);
  });

  it('a ridge whose two sides the height map holds a metre apart is a ridge, not an eave over a wall', () => {
    // The north half stands 1 m above the south half at the ridge; both fall away from it at 6/12.
    const shape = halves('offset ridge', ({ y }) => 6 - 0.5 * y, ({ y }) => 5 + 0.5 * y);
    const seg: Segmentation = {
      outline: rect(5, 4),
      faceOf: ({ y }) => (y >= 0 ? 0 : 1),
      planes: [
        { a: 0, b: -0.5, c: 6 },
        { a: 0, b: 0.5, c: 5 },
      ],
    };
    const on = topologyOf(shape, seg);
    expect(on.total('ridge')).toBeGreaterThan(8.5);
    expect(on.total('flashing')).toBeLessThan(1.5);
    const off = topologyOf(shape, seg, { measuredRidge: false });
    expect(off.total('ridge')).toBeLessThan(1);
    expect(off.total('flashing')).toBeGreaterThan(8.5);
    // The upper half's edge over the wall was an eave: 10 m more of it with the rule off.
    expect(off.total('eave') - on.total('eave')).toBeGreaterThan(8.5);
  });

  it('is drawn once: the other side of a strip the planes cut off along a ridge is no second ridge', () => {
    // A gable 10 x 8 m at 6/12 whose north slope's top 0.8 m is a face of its own (a strip along the ridge, with a
    // plane falling to the south). The strip meets the north face in a ridge by the planes (0.8 m off the real one);
    // its other side, on the real ridge, is a wall by the planes (the strip's plane is 0.6 m under the south face's
    // there), and a ridge by the height map. One ridge is counted.
    const seg: Segmentation = {
      outline: rect(5, 4),
      faceOf: ({ y }) => (y >= 0.8 ? 0 : y >= 0 ? 1 : 2),
      planes: [
        { a: 0, b: -0.5, c: 5 },
        { a: 0, b: 0.3, c: 4.36 },
        { a: 0, b: 0.5, c: 5 },
      ],
    };
    const on = topologyOf(gableShape(10, 8, 6), seg);
    expect(on.total('ridge')).toBeGreaterThan(9);
    expect(on.total('ridge')).toBeLessThan(11);
    expect(on.total('pitch-break')).toBeGreaterThan(8.5);
    expect(on.total('flashing')).toBeLessThan(1);
    // Every such line a ridge (the duplicate check off): two ridges.
    expect(topologyOf(gableShape(10, 8, 6), seg, { ridgeBesideM: 0 }).total('ridge')).toBeGreaterThan(18.5);
    // The planes alone: an eave over a wall along the real ridge.
    const off = topologyOf(gableShape(10, 8, 6), seg, { measuredRidge: false });
    expect(off.total('flashing')).toBeGreaterThan(8.5);
    expect(off.total('eave') - on.total('eave')).toBeGreaterThan(8.5);
  });

  it('a real eave over a lower roof stays an eave', () => {
    // An upper roof falling south to y = 0, 1 m above a lower roof that falls on south from there.
    const shape = halves('eave over a lower roof', ({ y }) => 5 + 0.5 * y, ({ y }) => 4 + 0.5 * y);
    const seg: Segmentation = {
      outline: rect(5, 4),
      faceOf: ({ y }) => (y >= 0 ? 0 : 1),
      planes: [
        { a: 0, b: 0.5, c: 5 },
        { a: 0, b: 0.5, c: 4 },
      ],
    };
    const on = topologyOf(shape, seg);
    expect(on.total('ridge')).toBeLessThan(1);
    expect(on.near({ x: 0, y: 0 }).kind).toBe('eave');
  });
});

describe('a valley with a step down beside it is the upper roof\'s edge (valleyDropM)', () => {
  // An upper roof 8 m wide comes down to y = 0 at 6/12. A lower roof 10 m wide rises to the south from a metre lower:
  // a lower roof against the wall under the upper roof's eave. Its plane bridges the step (it meets the upper plane
  // 0.25 m south of the wall and the lower roof at its far edge), so the planes make a trough there. The line is drawn
  // between the outline's corners at the wall's ends, a little off where the planes cross (as on real roofs, where a
  // line's corners are shared with other lines).
  const shape: Shape = {
    name: 'eave over a rising lower roof',
    extent: 8,
    height: ({ x, y }) => (y >= 0 ? (Math.abs(x) <= 4 && y <= 4 ? 4 + 0.5 * y : null) : Math.abs(x) <= 5 && y >= -4 ? 3 - 0.5 * y : null),
    faces: [],
    lines: {},
    planAreaM2: 72,
  };
  const seg: Segmentation = {
    outline: [
      { x: -5, y: -4 },
      { x: 5, y: -4 },
      { x: 5, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: -4, y: 4 },
      { x: -4, y: 0 },
      { x: -5, y: 0 },
    ],
    faceOf: ({ y }) => (y >= 0 ? 0 : 1),
    planes: [
      { a: 0, b: 0.5, c: 4 },
      { a: 0, b: -0.3, c: 3.8 },
    ],
  };

  it('is named as along a wall: the upper face\'s eave and flashing on the lower roof', () => {
    const on = topologyOf(shape, seg);
    expect(on.total('valley')).toBeLessThan(1);
    expect(on.near({ x: 0, y: 0 }).kind).toBe('eave');
    expect(on.total('flashing')).toBeGreaterThan(7.5);
    const off = topologyOf(shape, seg, { valleyDropM: 0 });
    expect(off.near({ x: 0, y: 0 }).kind).toBe('valley');
    expect(off.total('valley')).toBeGreaterThan(7.5);
    expect(off.total('flashing')).toBeLessThan(1);
  });

  it('leaves a true valley a valley', () => {
    // The same two roofs meeting in a trough: the lower roof starts where the upper one ends, and its plane is its own.
    const trough: Shape = { ...shape, name: 'trough', height: ({ x, y }) => (y >= 0 ? (Math.abs(x) <= 4 && y <= 4 ? 4 + 0.5 * y : null) : Math.abs(x) <= 5 && y >= -4 ? 3.8 - 0.3 * y : null) };
    const on = topologyOf(trough, seg);
    expect(on.near({ x: 0, y: 0 }).kind).toBe('valley');
    expect(on.total('valley')).toBeGreaterThan(7.5);
  });
});

describe('a hip with a higher roof standing beside it is that roof\'s rake (hipStepM)', () => {
  // West of x = 0 an upper roof 8 m long climbs to the north at 6/12; its east edge (along x = 0) is its rake, a metre
  // above a lower roof 6 m long that falls away to the east. The upper face's plane bridges the step (it crosses the
  // lower plane 0.3 m west of the wall and meets the upper roof at its far edge): by the planes the line is a hip.
  const shape: Shape = {
    name: 'rake over a lower roof',
    extent: 8,
    height: ({ x, y }) => (x < 0 ? (x >= -5 && Math.abs(y) <= 4 ? 6 + 0.5 * y : null) : x <= 5 && Math.abs(y) <= 3 ? 5 + 0.5 * y - 0.5 * x : null),
    faces: [],
    lines: {},
    planAreaM2: 70,
  };
  const seg: Segmentation = {
    outline: [
      { x: -5, y: -4 },
      { x: 0, y: -4 },
      { x: 0, y: -3 },
      { x: 5, y: -3 },
      { x: 5, y: 3 },
      { x: 0, y: 3 },
      { x: 0, y: 4 },
      { x: -5, y: 4 },
    ],
    faceOf: ({ x }) => (x < 0 ? 0 : 1),
    planes: [
      { a: -0.18, b: 0.5, c: 5.1 },
      { a: -0.5, b: 0.5, c: 5 },
    ],
  };

  it('is named as along a wall: the upper face\'s rake, the lower roof flashed', () => {
    const on = topologyOf(shape, seg);
    expect(on.total('hip')).toBeLessThan(1);
    expect(on.near({ x: 0, y: 0 }).kind).toBe('rake');
    expect(on.total('flashing') + on.total('step-flashing')).toBeGreaterThan(5.5);
    const off = topologyOf(shape, seg, { hipStepM: 0 });
    expect(off.near({ x: 0, y: 0 }).kind).toBe('hip');
    expect(off.total('hip')).toBeGreaterThan(5.5);
  });

  it('leaves a true hip a hip', () => {
    const on = topologyOf(hipShape(14, 8, 8), {
      outline: rect(7, 4),
      faceOf: ({ x, y }) => (Math.abs(y) >= 4 - (7 - Math.abs(x)) ? (y >= 0 ? 0 : 1) : x > 0 ? 2 : 3),
      planes: [
        { a: 0, b: -8 / 12, c: 3 + (4 * 8) / 12 },
        { a: 0, b: 8 / 12, c: 3 + (4 * 8) / 12 },
        { a: -8 / 12, b: 0, c: 3 + (7 * 8) / 12 },
        { a: 8 / 12, b: 0, c: 3 + (7 * 8) / 12 },
      ],
    });
    expect(on.total('hip')).toBeGreaterThan(24);
    expect(on.total('rake')).toBeLessThan(1);
    expect(on.total('ridge')).toBeGreaterThan(5);
  });
});

describe('roofs the planes already name right', () => {
  // Tree crowns lean over these roofs' edges (the fixture's): heights beside an edge that are a crown's, not the roof's,
  // must not rename it. Each of these was renamed wrongly by the bare medians (a crown over half of a hip end's eave, a
  // gable's rake, a porch's eave) before the quorum and the crown guards.
  const cases = [
    [HIP, 45, 12],
    [PORCH, 17, 11],
    [TWO_STOREY, 17, 11],
    [L_CROSS, 17, 11],
  ] as const;
  it.each(cases)('$0.name keeps its line totals with every height-map rule on', (shape, turnDeg, seed) => {
    const syn = synthesize(shape, { turnDeg, seed });
    const totals = (topology: Partial<TopologyParams>): Record<string, number> => {
      const r = reconstructRoof(syn.raster, syn.point, { seed: 7, topology });
      expect(r, shape.name).not.toBeNull();
      const by: Record<string, number> = {};
      for (const l of r!.lines) by[l.kind] = (by[l.kind] ?? 0) + l.lengthM;
      return by;
    };
    const on = totals({});
    const off = totals({ measuredEdge: false, measuredRidge: false, valleyDropM: 0, hipStepM: 0 });
    for (const kind of new Set([...Object.keys(on), ...Object.keys(off)])) expect(Math.abs((on[kind] ?? 0) - (off[kind] ?? 0)), `${shape.name}: ${kind}`).toBeLessThan(0.5);
  }, 30_000);
});

describe('the development-only line features', () => {
  it('are collected only when asked for and do not change the lines', () => {
    const p = 8 / 12;
    const seg: Segmentation = { outline: rect(5, 4), faceOf: ({ y }) => (y >= 0 ? 0 : 1), planes: [{ a: 0, b: -p, c: 3 + 4 * p }, { a: 0, b: p, c: 3 + 4 * p }] };
    const rows: LineFeatures[] = [];
    const withRows = topologyOf(gableShape(10, 8, 8), seg, {}, rows);
    const without = topologyOf(gableShape(10, 8, 8), seg);
    expect(JSON.stringify(withRows.topo.lines)).toBe(JSON.stringify(without.topo.lines));
    expect(rows.length).toBeGreaterThanOrEqual(without.topo.lines.length);
    expect(rows.some((r) => r.kind === 'ridge' && r.src === 'crease')).toBe(true);
  });
});

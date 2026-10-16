import { describe, expect, it } from 'vitest';
import { buildRoofModel, type RoofModel } from '../src/roof-model.ts';
import {
  classifyEdge,
  compassSide,
  gutterCheck,
  DEFAULT_GUTTER_TIERS,
  downspoutCapacitySqFt,
  eaveHeight,
  GUTTER_DESIGN,
  gutterCapacitySqFt,
  gutterRuns,
  gutterView,
  measureGutters,
  priceGutters,
  rainPitchFactor,
} from '../src/gutters.ts';

// Little Rock origin; metres to degrees on the same sphere the engine uses.
const LNG0 = -92.2896;
const LAT0 = 34.7465;
const K = (Math.PI / 180) * 6371008.8;
const COS = Math.cos((LAT0 * Math.PI) / 180);
const pt = (x: number, y: number): [number, number] => [LNG0 + x / (K * COS), LAT0 + y / K];
const ring = (pts: [number, number][]) => pts.map(([x, y]) => pt(x, y));
const roofOf = (pts: [number, number][], pitchX12 = 6) => buildRoofModel([ring(pts)], { pitchX12, overhangFt: 1, planes: null })!;
const FT = 3.280839895;

const GABLE: [number, number][] = [[0, 0], [20, 0], [20, 10], [0, 10]];
const HIP: [number, number][] = [[0, 0], [12, 0], [12, 10], [0, 10]];
const L_SHAPE: [number, number][] = [[0, 0], [20, 0], [20, 8], [8, 8], [8, 20], [0, 20]];
const ASSUMED = eaveHeight({});

/** A sloped house (two faces of a 10 x 8 m gable, ridge east-west) and a flat porch roof on its south side. */
function porchRoof(): RoofModel {
  const facet = (id: string, pts: [number, number][], pitch: string, planSqFt: number, areaSqFt: number, azimuthDeg: number) => {
    const r = ring(pts);
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return { id, ring: [...r, r[0]!], planSqFt, areaSqFt, pitch, labelAt: pt(cx, cy), azimuthDeg };
  };
  const line = (kind: RoofModel['lines'][number]['kind'], a: [number, number], b: [number, number], facets: string[]) => ({
    kind,
    coords: [pt(...a), pt(...b)] as [[number, number], [number, number]],
    lengthFt: Math.hypot(b[0] - a[0], b[1] - a[1]) * FT,
    facets,
  });
  const half = 10 * 4 * FT * FT;
  return {
    facets: [
      facet('A', [[0, 0], [10, 0], [10, 4], [0, 4]], '6/12', half, half * 1.118, 180),
      facet('B', [[0, 4], [10, 4], [10, 8], [0, 8]], '6/12', half, half * 1.118, 0),
      facet('C', [[2, -3], [8, -3], [8, 0], [2, 0]], '1/12', 18 * FT * FT, 18 * FT * FT, 180),
    ],
    lines: [
      line('eave', [0, 0], [10, 0], ['A']),
      line('eave', [10, 8], [0, 8], ['B']),
      line('ridge', [0, 4], [10, 4], ['A', 'B']),
      { ...line('rake', [10, 0], [10, 8], ['A']), lengthFt: 8 * FT * 1.118 },
      { ...line('rake', [0, 8], [0, 0], ['A']), lengthFt: 8 * FT * 1.118 },
      line('flat-edge', [2, -3], [8, -3], ['C']),
      line('flat-edge', [8, -3], [8, 0], ['C']),
      line('flat-edge', [2, 0], [2, -3], ['C']),
    ],
    outline: ring([[0, -3], [10, -3], [10, 8], [0, 8], [0, -3]]),
    pitch: '6/12',
    totals: { squares: 0, slopedSqFt: 0, planSqFt: 0, facetCount: 3, wastePct: 10, ridgeFt: 0, hipFt: 0, valleyFt: 0, eaveFt: 0, rakeFt: 0 },
  };
}


describe('design constants', () => {
  it('keeps the Arkansas intensity and capacities in one place', () => {
    expect(GUTTER_DESIGN.rainfallInPerHr).toBe(7.96);
    expect(Math.round(gutterCapacitySqFt('5in'))).toBe(693);
    expect(Math.round(gutterCapacitySqFt('6in'))).toBe(1000);
    expect(Math.round(downspoutCapacitySqFt('2x3'))).toBe(905);
    expect(Math.round(downspoutCapacitySqFt('3x4'))).toBe(1809);
  });
  it('uses the published roof pitch factors', () => {
    expect([0, 3, 4, 5, 6, 8, 9, 11, 12, 18].map(rainPitchFactor)).toEqual([1, 1, 1.05, 1.05, 1.1, 1.1, 1.2, 1.2, 1.3, 1.3]);
  });
  it('names compass sides', () => {
    expect(compassSide({ x: 0, y: -1 })).toBe('south');
    expect(compassSide({ x: 1, y: 1 })).toBe('northeast');
    expect(compassSide({ x: -1, y: 0 })).toBe('west');
  });
});

describe('gutterRuns', () => {
  it('a gable has two eave runs and no gutters on its rakes', () => {
    const roof = roofOf(GABLE);
    const { runs, corners } = gutterRuns(roof);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.side).sort()).toEqual(['north', 'south']);
    const eaveFt = roof.lines.filter((l) => l.kind === 'eave').reduce((s, l) => s + l.lengthFt, 0);
    expect(runs.reduce((s, r) => s + r.lengthFt, 0)).toBeCloseTo(eaveFt, 0);
    expect(corners).toEqual([]);
    // Each run drains its half of the roof, adjusted for a 6/12 pitch.
    const plan = roof.facets.reduce((s, f) => s + f.planSqFt, 0);
    expect(runs[0]!.planSqFt + runs[1]!.planSqFt).toBeCloseTo(plan, -1);
    expect(runs[0]!.designSqFt).toBeCloseTo(runs[0]!.planSqFt * 1.1, -1);
    expect(runs[0]!.slopedSqFt).toBeGreaterThan(runs[0]!.planSqFt);
  });

  it('a hip roof is one loop of four runs with four outside corners', () => {
    const { runs, corners } = gutterRuns(roofOf(HIP));
    expect(runs).toHaveLength(4);
    expect(corners).toHaveLength(4);
    expect(corners.every((c) => c.kind === 'outside')).toBe(true);
    expect(runs.map((r) => r.side).sort()).toEqual(['east', 'north', 'south', 'west']);
  });

  it('an L-shape has an inside corner at its re-entrant corner', () => {
    const { runs, corners } = gutterRuns(roofOf(L_SHAPE));
    expect(runs.length).toBeGreaterThanOrEqual(4);
    expect(corners.filter((c) => c.kind === 'inside')).toHaveLength(1);
    expect(corners.filter((c) => c.kind === 'outside').length).toBeGreaterThanOrEqual(1);
  });

  it('merges collinear touching eave pieces into one run', () => {
    const roof = roofOf(GABLE);
    const south = roof.lines.find((l) => l.kind === 'eave')!;
    const [a, b] = south.coords;
    const m: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const split: RoofModel = {
      ...roof,
      lines: [...roof.lines.filter((l) => l !== south), { ...south, coords: [a, m], lengthFt: south.lengthFt / 2 }, { ...south, coords: [m, b], lengthFt: south.lengthFt / 2 }],
    };
    const runs = gutterRuns(split).runs;
    expect(runs).toHaveLength(2);
    expect(runs[0]!.lengthFt).toBeCloseTo(south.lengthFt, 0);
  });

  it('a low porch roof gets its own run along its downhill edge only', () => {
    const { runs, corners } = gutterRuns(porchRoof());
    const porch = runs.filter((r) => r.kind === 'low-attachment');
    expect(porch).toHaveLength(1);
    expect(porch[0]!.side).toBe('south');
    expect(porch[0]!.lengthFt).toBeCloseTo(6 * FT, 0);
    expect(porch[0]!.facets).toEqual(['C']);
    expect(runs.filter((r) => r.kind === 'main')).toHaveLength(2);
    expect(corners).toEqual([]);
  });

  it('is empty without a roof', () => {
    expect(gutterRuns(null)).toEqual({ runs: [], corners: [] });
  });
});

describe('downspouts', () => {
  it('one at the end of a run up to 40 ft, then one at each end and enough between to stay within 40 ft', () => {
    const g = measureGutters(roofOf(HIP), ASSUMED);
    for (const r of g.runs) {
      expect(r.lengthFt).toBeLessThanOrEqual(40);
      expect(r.downspouts).toHaveLength(1);
      expect(r.downspouts[0]!.atFt).toBe(r.lengthFt);
    }
    // Every corner of a hip roof gets exactly one downspout.
    const at = new Set(g.runs.map((r) => r.downspouts[0]!.at.map((v) => v.toFixed(6)).join(',')));
    expect(at.size).toBe(4);

    const gable = measureGutters(roofOf(GABLE), ASSUMED);
    for (const r of gable.runs) {
      expect(r.lengthFt).toBeGreaterThan(40);
      const ats = r.downspouts.map((d) => d.atFt);
      expect(ats[0]).toBe(0);
      expect(ats[ats.length - 1]).toBe(r.lengthFt);
      for (let i = 1; i < ats.length; i++) expect(ats[i]! - ats[i - 1]!).toBeLessThanOrEqual(40);
    }
  });

  it('adds downspouts so none drains more than its capacity', () => {
    // A very large 12/12 hip (40 x 40 m): each 131 ft run drains a 20 m deep slope, more than spacing alone covers.
    const g = measureGutters(roofOf([[0, 0], [40, 0], [40, 40], [0, 40]], 12), ASSUMED, { size: '5in' });
    const cap = downspoutCapacitySqFt('2x3');
    for (const r of g.runs) {
      const spacing = Math.ceil(r.lengthFt / 40) + 1;
      expect(r.downspouts.length).toBe(Math.ceil(r.designSqFt / cap));
      expect(r.downspouts.length).toBeGreaterThan(spacing);
    }
  });

  it('downspout length is the eave height: Google, else floors x 10 ft, else one floor assumed', () => {
    expect(eaveHeight({ eaveHeightM: 5.8 })).toEqual({ heightFt: 19, floors: 2, source: 'google' });
    expect(eaveHeight({ floors: 2 })).toEqual({ heightFt: 20, floors: 2, source: 'floors' });
    expect(eaveHeight({ eaveHeightM: 40, floors: null })).toEqual({ heightFt: 10, floors: 1, source: 'assumed' });
    const g = measureGutters(roofOf(HIP), eaveHeight({ floors: 2 }));
    expect(g.totals.downspoutFt).toBe(4 * 20);
    // A porch's downspout is one floor long even on a two-floor house.
    const p = measureGutters(porchRoof(), eaveHeight({ floors: 2 }));
    const porch = p.runs.find((r) => r.kind === 'low-attachment')!;
    expect(porch.downspouts.every((d) => d.lengthFt === 10)).toBe(true);
  });

  it('a short run turning into a longer one drains into it', () => {
    // An L whose short wing end is 2 m: its eave is under 8 ft.
    const g = measureGutters(roofOf([[0, 0], [14, 0], [14, 10], [2, 10], [2, 12], [0, 12]]), ASSUMED);
    const short = g.runs.filter((r) => r.lengthFt < GUTTER_DESIGN.shortRunFt && g.corners.some((c) => c.runIds.includes(r.id)));
    for (const r of short) expect(r.downspouts).toHaveLength(0);
  });
});

describe('size', () => {
  it('5 in when every run sends less than 5 in carries to one downspout, with the reason', () => {
    const g = measureGutters(roofOf(HIP), ASSUMED);
    expect(g.size.recommended).toBe('5in');
    expect(g.size.downspout).toBe('2x3');
    expect(g.size.reason).toMatch(/^5 in: .* within a 5 in gutter's 693$/);
  });

  it('6 in when a run sends more than 693 sq ft to one downspout, naming the run', () => {
    const g = measureGutters(roofOf(L_SHAPE), ASSUMED);
    expect(g.size.recommended).toBe('6in');
    expect(g.size.downspout).toBe('3x4');
    expect(g.size.reason).toMatch(/^6 in: the \w+ run sends [\d,]+ sq ft to one downspout/);
  });

  it('a size chosen by hand wins and says so', () => {
    const g = measureGutters(roofOf(L_SHAPE), ASSUMED, { size: '5in' });
    expect(g.size).toMatchObject({ recommended: '6in', chosen: '5in', downspout: '2x3', overridden: true });
    expect(g.size.reason).toMatch(/^5 in, chosen by hand/);
  });
});

describe('adjustments and totals', () => {
  it('leaving a run out drops its feet, its corners and opens end caps on its neighbours', () => {
    const all = measureGutters(roofOf(HIP), ASSUMED);
    expect(all.totals).toMatchObject({ runs: 4, outsideCorners: 4, endCaps: 0, downspouts: 4, outlets: 4, elbows: 12 });
    const out = measureGutters(roofOf(HIP), ASSUMED, { excludedRunIds: ['G1', 'nope'] });
    expect(out.runs.find((r) => r.id === 'G1')!.excluded).toBe(true);
    expect(out.totals.runs).toBe(3);
    expect(out.totals.outsideCorners).toBe(2);
    expect(out.totals.endCaps).toBe(2);
    expect(out.totals.gutterFt).toBeCloseTo(all.totals.gutterFt - all.runs[0]!.lengthFt, 1);
  });

  it('downspouts typed in per run replace the worked-out count (clamped)', () => {
    const g = measureGutters(roofOf(HIP), ASSUMED, { downspouts: { G1: 3, G2: 0, G3: 99, X: 4 } });
    expect(g.runs.find((r) => r.id === 'G1')!.downspouts).toHaveLength(3);
    expect(g.runs.find((r) => r.id === 'G2')!.downspouts).toHaveLength(0);
    expect(g.runs.find((r) => r.id === 'G3')!.downspouts).toHaveLength(12);
    expect(g.runs.find((r) => r.id === 'G1')!.downspoutsSet).toBe(true);
  });

  it('hangers every 2 ft, 3 elbows a downspout', () => {
    const g = measureGutters(roofOf(GABLE), ASSUMED);
    expect(g.totals.hangers).toBe(g.runs.reduce((s, r) => s + Math.ceil(r.lengthFt / 2), 0));
    expect(g.totals.elbows).toBe(3 * g.totals.downspouts);
  });
});

describe('priceGutters', () => {
  it('prices Good, Better and Best from gutter feet, downspout feet, corners and guards', () => {
    const g = measureGutters(roofOf(HIP), eaveHeight({ floors: 1 }));
    const quotes = priceGutters(g, null);
    expect(quotes.map((q) => q.tier)).toEqual(['good', 'better', 'best']);
    const ft = g.totals.gutterFt;
    const [good, better, best] = quotes;
    expect(good!.lines).toEqual([
      { kind: 'gutter', quantity: ft, unit: 'ft', unitCents: 900, amountCents: Math.round(ft * 900) },
      { kind: 'downspout', quantity: 40, unit: 'ft', unitCents: 800, amountCents: 32_000 },
      { kind: 'corner', quantity: 4, unit: 'each', unitCents: 2_500, amountCents: 10_000 },
    ]);
    expect(good!.totalCents).toBe(Math.round(ft * 900) + 32_000 + 10_000);
    expect(better!.totalCents).toBe(Math.round(ft * 1150) + 40_000 + 12_000);
    expect(best!.lines.find((l) => l.kind === 'guard')).toEqual({ kind: 'guard', quantity: ft, unit: 'ft', unitCents: 900, amountCents: Math.round(ft * 900) });
    expect(best!.totalCents).toBe(better!.totalCents + Math.round(ft * 900));
    expect(quotes.every((q) => !q.belowRecommended)).toBe(true);
  });

  it('leaves out excluded runs and flags a 5 in tier when 6 in is recommended', () => {
    const g = measureGutters(roofOf(L_SHAPE), ASSUMED);
    const all = priceGutters(g, null);
    const less = priceGutters(g, { excludedRunIds: ['G1'] });
    expect(less[0]!.totalCents).toBeLessThan(all[0]!.totalCents);
    expect(all[0]!.belowRecommended).toBe(true);
    expect(all[1]!.belowRecommended).toBe(false);
  });

  it('skips disabled tiers', () => {
    const g = measureGutters(roofOf(HIP), ASSUMED);
    expect(priceGutters(g, null, DEFAULT_GUTTER_TIERS.map((t) => ({ ...t, enabled: t.tier !== 'best' }))).map((q) => q.tier)).toEqual(['good', 'better']);
  });
});

describe('gutterView', () => {
  it('carries rakes for the drawing, clean adjustments and null quotes without tiers', () => {
    const v = gutterView('m1', roofOf(GABLE), ASSUMED, { excludedRunIds: ['G2', 'G9'] }, null);
    expect(v.rakes.length).toBeGreaterThan(0);
    expect(v.adjustments).toEqual({ excludedRunIds: ['G2'], downspouts: {}, size: null });
    expect(v.quotes).toBeNull();
    expect(gutterView('m1', null, ASSUMED, null).runs).toEqual([]);
  });
});

describe('3D roof edges', () => {
  it('drops a lone eave piece under 4 ft (a jog) but keeps a short one that turns a corner', () => {
    const roof = roofOf(GABLE);
    const eave = roof.lines.find((l) => l.kind === 'eave')!;
    const [a] = eave.coords;
    const stub: [number, number] = [a[0], a[1] - 0.9 / K]; // 0.9 m south of the eave's start, alone
    const lone = { ...eave, coords: [[stub[0] - 0.9 / (K * COS), stub[1]], stub] as [[number, number], [number, number]], lengthFt: 0.9 * FT };
    expect(gutterRuns({ ...roof, lines: [...roof.lines, lone] }).runs).toHaveLength(2);
  });
});

/** A roof model by hand: facets as [id, plan points (m), pitch x/12, downhill azimuth], lines as [kind, a, b, facets, rise ft]. */
function handRoof(
  facets: [string, [number, number][], number, number | undefined][],
  lines: [string, [number, number], [number, number], string[], number][],
  outline: [number, number][],
): RoofModel {
  return {
    facets: facets.map(([id, pts, pitch, az]) => {
      const cx = pts.reduce((t, p) => t + p[0], 0) / pts.length;
      const cy = pts.reduce((t, p) => t + p[1], 0) / pts.length;
      const r = ring(pts);
      const area = Math.abs(pts.reduce((t, p, k) => t + p[0] * pts[(k + 1) % pts.length]![1] - pts[(k + 1) % pts.length]![0] * p[1], 0) / 2) * FT * FT;
      return { id, ring: [...r, r[0]!], planSqFt: area, areaSqFt: area * 1.1, pitch: `${pitch}/12`, labelAt: pt(cx, cy), ...(az !== undefined ? { azimuthDeg: az } : {}) };
    }),
    lines: lines.map(([kind, a, b, fs, rise]) => {
      const plan = Math.hypot(b[0] - a[0], b[1] - a[1]) * FT;
      return { kind: kind as RoofModel['lines'][number]['kind'], coords: [pt(...a), pt(...b)] as [[number, number], [number, number]], lengthFt: Math.hypot(plan, rise), facets: fs };
    }),
    outline: [...ring(outline), ring(outline)[0]!],
    pitch: '6/12',
    totals: { squares: 0, slopedSqFt: 0, planSqFt: 0, facetCount: facets.length, wastePct: 10, ridgeFt: 0, hipFt: 0, valleyFt: 0, eaveFt: 0, rakeFt: 0 },
  };
}

describe('classifyEdge (from the face plane, not the label)', () => {
  const base = { pitchX12: 6, climbX12: 0, label: 'rake' };
  it('downhill within 45 degrees of the outward normal is an eave, 60 or more a rake', () => {
    expect(classifyEdge({ ...base, outward: { x: 0, y: -1 }, downhillDeg: 180 })).toBe('eave');
    expect(classifyEdge({ ...base, outward: { x: 1, y: -1 }, downhillDeg: 180 })).toBe('eave'); // 45
    expect(classifyEdge({ ...base, label: 'eave', outward: { x: 1, y: 0 }, downhillDeg: 180 })).toBe('rake'); // 90
    expect(classifyEdge({ ...base, label: 'eave', outward: { x: Math.sin((61 * Math.PI) / 180), y: -Math.cos((61 * Math.PI) / 180) }, downhillDeg: 180, climbX12: 0 })).toBe('rake'); // past 60, even level
  });
  it('between 45 and 60 degrees the edge\'s climb decides; a climb too close to call uses the label', () => {
    const at52 = { x: Math.sin((52 * Math.PI) / 180), y: -Math.cos((52 * Math.PI) / 180) };
    expect(classifyEdge({ ...base, outward: at52, downhillDeg: 180, climbX12: 0.3 })).toBe('eave');
    expect(classifyEdge({ ...base, label: 'eave', outward: at52, downhillDeg: 180, climbX12: 4 })).toBe('rake');
    expect(classifyEdge({ ...base, label: 'eave', outward: at52, downhillDeg: 180, climbX12: 1.5 })).toBe('eave');
    expect(classifyEdge({ ...base, label: 'rake', outward: at52, downhillDeg: 180, climbX12: 1.5 })).toBe('rake');
  });
  it('a face with no direction (or a flat one) falls back on the label', () => {
    expect(classifyEdge({ ...base, label: 'eave', outward: { x: 1, y: 0 }, downhillDeg: null })).toBe('eave');
    expect(classifyEdge({ ...base, label: 'rake', pitchX12: 1, outward: { x: 0, y: -1 }, downhillDeg: 180 })).toBe('rake');
  });
});

describe('runs from the planes on whole roofs', () => {
  it('hip: gutters all round; gable: only along the eaves', () => {
    const hip = gutterRuns(roofOf(HIP));
    expect(hip.runs.reduce((t, r) => t + r.lengthFt, 0)).toBeCloseTo(gutterCheck(roofOf(HIP), []).perimeterFt, -1);
    const gable = gutterRuns(roofOf(GABLE));
    expect(gable.runs.map((r) => r.side).sort()).toEqual(['north', 'south']);
  });

  it('L-shape: eaves on both wings, none on the two gable ends', () => {
    const roof = roofOf(L_SHAPE);
    const runs = gutterRuns(roof).runs;
    const rakeFt = roof.lines.filter((l) => l.kind === 'rake').length;
    expect(rakeFt).toBeGreaterThan(0);
    const eaveFt = roof.lines.filter((l) => l.kind === 'eave').reduce((t, l) => t + l.lengthFt, 0);
    expect(runs.reduce((t, r) => t + r.lengthFt, 0)).toBeCloseTo(eaveFt, 0);
  });

  it('Dutch gable: eaves on all four sides, the little gable\'s rakes (above the hips) take none', () => {
    // 12 x 8 m: front and back faces, hipped ends from y 2..6 at the ends, a small gable on top of each end.
    const roof = handRoof(
      [
        ['A', [[0, 0], [12, 0], [10, 3], [2, 3]], 6, 180],
        ['B', [[0, 8], [2, 5], [10, 5], [12, 8]], 6, 0],
        ['C', [[12, 0], [12, 8], [10, 5], [10, 3]], 6, 90],
        ['D', [[0, 0], [2, 3], [2, 5], [0, 8]], 6, 270],
      ],
      [
        ['eave', [0, 0], [12, 0], ['A'], 0],
        ['eave', [12, 8], [0, 8], ['B'], 0],
        ['eave', [12, 0], [12, 8], ['C'], 0],
        ['eave', [0, 8], [0, 0], ['D'], 0],
        // The small gables' rakes, drawn on the front and back faces where the hips stop
        ['rake', [10, 3], [10, 4], ['A'], 2],
        ['rake', [2, 3], [2, 4], ['A'], 2],
        ['rake', [10, 5], [10, 4], ['B'], 2],
        ['rake', [2, 5], [2, 4], ['B'], 2],
        ['hip', [12, 0], [10, 3], ['A', 'C'], 4],
        ['ridge', [2, 4], [10, 4], ['A', 'B'], 0],
      ],
      [[0, 0], [12, 0], [12, 8], [0, 8]],
    );
    const { runs, corners } = gutterRuns(roof);
    expect(runs).toHaveLength(4);
    expect(runs.map((r) => r.side).sort()).toEqual(['east', 'north', 'south', 'west']);
    expect(corners).toHaveLength(4);
  });

  it('mislabelled edges (a Ridgeway-like 3D roof): eaves drawn as rakes still get gutters, rakes drawn as eaves do not', () => {
    // A 14 x 9 m gable, ridge east-west: the long sides are the eaves. The reconstruction swapped the labels and
    // gave the eaves a little height noise.
    const roof = handRoof(
      [
        ['A', [[0, 0], [14, 0], [14, 4.5], [0, 4.5]], 8, 180],
        ['B', [[0, 4.5], [14, 4.5], [14, 9], [0, 9]], 8, 0],
      ],
      [
        ['rake', [0, 0], [14, 0], ['A'], 0.6],
        ['rake', [14, 9], [0, 9], ['B'], 0.4],
        ['eave', [14, 0], [14, 4.5], ['A'], 9.8],
        ['eave', [14, 4.5], [14, 9], ['B'], 9.8],
        ['eave', [0, 9], [0, 4.5], ['B'], 9.8],
        ['eave', [0, 4.5], [0, 0], ['A'], 9.8],
        ['ridge', [0, 4.5], [14, 4.5], ['A', 'B'], 0],
      ],
      [[0, 0], [14, 0], [14, 9], [0, 9]],
    );
    const { runs } = gutterRuns(roof);
    expect(runs.map((r) => r.side).sort()).toEqual(['north', 'south']);
    expect(runs.reduce((t, r) => t + r.lengthFt, 0)).toBeCloseTo(28 * FT, 0);
    const check = gutterCheck(roof, runs);
    expect(check.share).toBeCloseTo((28 / 46), 1);
    expect(check.reasons).toEqual([]);
  });
});

describe('gutterCheck', () => {
  it('flags gutters under 45% of the perimeter, or under 40 ft on a house over 800 sq ft', () => {
    const roof = roofOf(GABLE);
    const c = gutterCheck(roof, gutterRuns(roof).runs);
    expect(c.perimeterFt).toBeCloseTo(2 * (20 + 10) * FT, 0); // the footprint's outline
    expect(c.reasons).toEqual([]);
    expect(c.expectedShare).toBeCloseTo(0.55, 2);
    expect(gutterCheck(roof, [{ lengthFt: 40 }]).reasons).toEqual(['gutters-check']);
    expect(gutterCheck(roofOf(HIP), []).expectedShare).toBeGreaterThan(0.9);
    // A small house (under 800 sq ft) at half its perimeter is fine; the 40 ft floor applies to bigger ones only.
    const small = roofOf([[0, 0], [6, 0], [6, 5], [0, 5]]);
    expect(gutterCheck(small, [{ lengthFt: gutterCheck(small, []).perimeterFt * 0.5 }]).reasons).toEqual([]);
  });
  it('is part of the measurement', () => {
    expect(measureGutters(roofOf(HIP), ASSUMED).check.reasons).toEqual([]);
  });
});

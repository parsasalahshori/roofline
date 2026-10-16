// Gutters measured from a roof: the eaves of a measured roof (RoofModel, from an outline or a 3D reconstruction) as
// gutter runs, with corners, drainage areas, downspouts, a 5 in / 6 in K-style size and Good / Better / Best quotes.
// Pure TypeScript, deterministic, never throws. No outside data: everything comes from the roof already measured
// (and an eave height when one is known).
//
// How it works (local metres round the roof):
// 1. Eave lines (never rakes, ridges, hips, valleys or flashing; a "rake" of a 3D roof that is in fact level counts as
//    an eave) are turned so their facet lies on their left, then touching collinear pieces are merged; pieces too
//    short to gutter (under 2 ft, or under 4 ft and turning no corner) are dropped. Each straight run ends at a corner or an open end. Low porch or patio
//    roofs (flat facets that are a small part of the roof: the reconstruction's 'low-attachment') give their own
//    runs along their downhill edges, never merged with the house's.
// 2. Two runs that meet end to start make a corner: a left turn is an outside (convex) corner, a right turn an
//    inside one. A corner counts (a miter) only while both its runs are on the quote.
// 3. Each facet's plan area is shared among its runs by length; sized with a roof pitch factor (wind-driven rain on
//    a sloped roof) and a design rainfall intensity (GUTTER_DESIGN).
// 4. Downspouts: one at the run's end, or one at each end and more between once the run is longer than the spacing,
//    and more again until each drains no more than its capacity. The size is 6 in when any run sends more water to
//    one downspout than a 5 in gutter carries.
import type { LngLat } from './roof.ts';
import type { RoofFacet, RoofLine, RoofModel } from './roof-model.ts';
import type { Tier } from './proposals.ts';

// ---------------------------------------------------------------------------------------------------------
// Design constants: every number the size and downspout rules use, in one place.

export const GUTTER_SIZES = ['5in', '6in'] as const;
export type GutterSize = (typeof GUTTER_SIZES)[number];
export const DOWNSPOUT_SIZES = ['2x3', '3x4'] as const;
export type DownspoutSize = (typeof DOWNSPOUT_SIZES)[number];

/**
 * The gutter sizing method (the SMACNA-style "adjusted area" method gutter makers publish):
 *   adjusted area = plan (horizontally projected) area x roof pitch factor x design rainfall intensity (in/hr),
 * compared with each gutter's capacity at 1 in/hr. Sources:
 * - Design intensity: NOAA Atlas 14, Volume 9 (Southeastern States) version 2, Precipitation Frequency Data Server,
 *   Little Rock, Arkansas (34.7465 N, 92.2896 W), partial-duration series, 5-minute duration, 10-year recurrence:
 *   7.96 in/hr (2-yr 5.94, 25-yr 9.16, 100-yr 10.9). SMACNA's Architectural Sheet Metal Manual sizes gutters on the
 *   10-year 5-minute storm. Another Arkansas town: change `rainfallInPerHr` (NW Arkansas is within about 0.3 in/hr).
 * - Gutter capacity at 1 in/hr: 5 in K-style 5,520 sq ft, 6 in K-style 7,960 sq ft (the industry table, e.g. City of
 *   Naples FL stormwater guide "Gutter sizing"; This Old House "Gutter sizes"). It is the area one gutter run carries
 *   to its outlet, so it is compared with the area that drains to one downspout from one side.
 * - Roof pitch factor (same tables): up to 3/12 1.0, 4-5/12 1.05, 6-8/12 1.1, 9-11/12 1.2, 12/12 and up 1.3.
 * - Downspout (leader) capacity: SMACNA's leader sizing, 1 sq in of leader per 1,200 / I sq ft of plan area (nominal
 *   2x3 = 6 sq in, 3x4 = 12 sq in), so at 7.96 in/hr a 2x3 drains about 900 sq ft and a 3x4 about 1,800.
 *   (Constant from the manual's leader table as commonly quoted; verify against the current edition.)
 * - Spacing: a downspout every 40 ft at most (installer practice is 30-40 ft; SMACNA's limit is 50 ft).
 */
export const GUTTER_DESIGN = {
  rainfallInPerHr: 7.96,
  rainfallSource: 'NOAA Atlas 14 Vol. 9, Little Rock AR, 10-year 5-minute',
  gutterSqFtAt1InHr: { '5in': 5520, '6in': 7960 } as Readonly<Record<GutterSize, number>>,
  downspoutFor: { '5in': '2x3', '6in': '3x4' } as Readonly<Record<GutterSize, DownspoutSize>>,
  downspoutSqIn: { '2x3': 6, '3x4': 12 } as Readonly<Record<DownspoutSize, number>>,
  leaderSqFtPerSqInAt1InHr: 1200,
  maxDownspoutSpacingFt: 40,
  /** A run this short that turns a corner into another run drains into it (no downspout of its own). */
  shortRunFt: 8,
  /** Eave pieces shorter than this are noise in the drawing: no gutter. */
  minRunFt: 2,
  /** A run this short with no corner into another run (a jog over a bay) gets no gutter of its own. */
  minLoneRunFt: 4,
  /** A line drawn as a rake that climbs less than this (x/12) is level: water leaves the roof there, so it is an eave. */
  levelRakeMaxX12: 1.5,
  hangerSpacingFt: 2,
  elbowsPerDownspout: 3,
  floorHeightFt: 10,
  /** A flat facet (under this pitch) of at most `lowAttachmentMaxShare` of the roof's plan area is a porch or patio roof. */
  lowAttachmentMaxX12: 2,
  lowAttachmentMaxShare: 0.4,
  /** A porch roof's eave is about one floor up. */
  lowAttachmentEaveFt: 10,
} as const;

/** The roof pitch factor for gutter sizing (see GUTTER_DESIGN). */
export function rainPitchFactor(pitchX12: number): number {
  const p = Number.isFinite(pitchX12) ? pitchX12 : 0;
  if (p < 3.5) return 1;
  if (p < 5.5) return 1.05;
  if (p < 8.5) return 1.1;
  if (p < 11.5) return 1.2;
  return 1.3;
}

/** Plan area (sq ft) one gutter run of this size carries to one outlet at the design intensity. */
export function gutterCapacitySqFt(size: GutterSize, rainfallInPerHr: number = GUTTER_DESIGN.rainfallInPerHr): number {
  return GUTTER_DESIGN.gutterSqFtAt1InHr[size] / rainfallInPerHr;
}

/** Plan area (sq ft, already pitch-adjusted) one downspout drains at the design intensity. */
export function downspoutCapacitySqFt(size: DownspoutSize, rainfallInPerHr: number = GUTTER_DESIGN.rainfallInPerHr): number {
  return (GUTTER_DESIGN.downspoutSqIn[size] * GUTTER_DESIGN.leaderSqFtPerSqInAt1InHr) / rainfallInPerHr;
}

// ---------------------------------------------------------------------------------------------------------
// Types.

export type GutterRunKind = 'main' | 'low-attachment';
export type CompassSide = 'north' | 'northeast' | 'east' | 'southeast' | 'south' | 'southwest' | 'west' | 'northwest';

/** Where the eave height (downspout length) came from. */
export type EaveHeightSource = 'google' | 'floors' | 'assumed';
export type EaveHeight = { heightFt: number; floors: number; source: EaveHeightSource };

/** A straight gutter run along one eave, before adjustments. */
export type GutterRunGeometry = {
  /** 'G1', 'G2', ...: house runs longest first, then porch runs. */
  id: string;
  kind: GutterRunKind;
  /** [lng, lat] start and end; the roof drains to the run's left-hand side going start to end. */
  coords: [LngLat, LngLat];
  lengthFt: number;
  /** Compass side of the house the run is on (the way water leaves the roof). */
  side: CompassSide;
  /** Facet ids that drain into it. */
  facets: string[];
  /** Plan (projected) area that drains into it, sq ft. */
  planSqFt: number;
  /** True (sloped) area of the same roof, sq ft. */
  slopedSqFt: number;
  /** Plan area times the roof pitch factor: what sizes the gutter and downspouts, sq ft. */
  designSqFt: number;
};

export type GutterCornerKind = 'inside' | 'outside';
export type GutterCorner = { at: LngLat; kind: GutterCornerKind; runIds: [string, string] };

export type GutterAdjustments = {
  /** Runs left off the quote. */
  excludedRunIds: string[];
  /** Downspouts typed in per run (replaces the worked-out count). */
  downspouts: Record<string, number>;
  /** The size chosen by hand; null: the recommended one. */
  size: GutterSize | null;
};

export const EMPTY_GUTTER_ADJUSTMENTS: GutterAdjustments = { excludedRunIds: [], downspouts: {}, size: null };
export const MAX_DOWNSPOUTS_PER_RUN = 12;
export const MAX_GUTTER_RUNS = 200;

export type Downspout = { atFt: number; at: LngLat; lengthFt: number };

export type GutterRun = GutterRunGeometry & {
  excluded: boolean;
  downspouts: Downspout[];
  /** The count was typed in (adjustments.downspouts). */
  downspoutsSet: boolean;
  /** Open ends that need an end cap (an end at a corner into a quoted run has none). */
  endCaps: number;
  corners: { inside: number; outside: number };
  /** Area that reaches one downspout from one side (sq ft, design): what the size is checked against. */
  flowSqFt: number;
  eaveHeightFt: number;
};

export type GutterTotals = {
  runs: number;
  gutterFt: number;
  downspouts: number;
  downspoutFt: number;
  insideCorners: number;
  outsideCorners: number;
  endCaps: number;
  hangers: number;
  outlets: number;
  elbows: number;
  designSqFt: number;
};

export type GutterSizing = {
  recommended: GutterSize;
  chosen: GutterSize;
  downspout: DownspoutSize;
  /** Plain English, e.g. "6 in: the north run sends 1,420 sq ft to one downspout, more than 5 in carries (693)". */
  reason: string;
  overridden: boolean;
};

export type GutterMeasure = {
  runs: GutterRun[];
  corners: GutterCorner[];
  size: GutterSizing;
  eave: EaveHeight;
  totals: GutterTotals;
  design: { rainfallInPerHr: number; rainfallSource: string; capacitySqFt: Record<GutterSize, number> };
};

// ---------------------------------------------------------------------------------------------------------
// Geometry kit (local metres, x east, y north).

type V = { x: number; y: number };
const EARTH_RADIUS_M = 6371008.8;
const FT_PER_M = 3.280839895;
/** Endpoints this close (m) touch. */
const JOIN_M = 0.5;
/** Pieces within this angle (deg) are collinear. */
const COLLINEAR_DEG = 10;

type Frame = { toLocal: (p: readonly [number, number]) => V; toLngLat: (v: V) => LngLat };

function frameFor(points: readonly (readonly [number, number])[]): Frame {
  const n = Math.max(1, points.length);
  const lng0 = points.reduce((s, p) => s + p[0], 0) / n;
  const lat0 = points.reduce((s, p) => s + p[1], 0) / n;
  const k = (Math.PI / 180) * EARTH_RADIUS_M;
  const cos = Math.cos((lat0 * Math.PI) / 180) || 1;
  return {
    toLocal: (p) => ({ x: (p[0] - lng0) * k * cos, y: (p[1] - lat0) * k }),
    toLngLat: (v) => [lng0 + v.x / (k * cos), lat0 + v.y / k],
  };
}

const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a: V): number => Math.hypot(a.x, a.y);
const cross = (a: V, b: V): number => a.x * b.y - a.y * b.x;
const dot = (a: V, b: V): number => a.x * b.x + a.y * b.y;
const near = (a: V, b: V, tol = JOIN_M): boolean => len(sub(a, b)) <= tol;
const round1 = (v: number): number => Math.round(v * 10) / 10;

function angleDeg(a: V, b: V): number {
  const la = len(a);
  const lb = len(b);
  if (la === 0 || lb === 0) return 180;
  return (Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (la * lb)))) * 180) / Math.PI;
}

function centroid(ring: readonly V[]): V {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    const c = p.x * q.y - q.x * p.y;
    a += c;
    cx += (p.x + q.x) * c;
    cy += (p.y + q.y) * c;
  }
  if (Math.abs(a) < 1e-9) {
    const n = Math.max(1, ring.length);
    return { x: ring.reduce((s, p) => s + p.x, 0) / n, y: ring.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

const SIDES: CompassSide[] = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

/** The compass side an outward direction points to. */
export function compassSide(dir: { x: number; y: number }): CompassSide {
  const bearing = ((Math.atan2(dir.x, dir.y) * 180) / Math.PI + 360) % 360;
  return SIDES[Math.round(bearing / 45) % 8]!;
}

/** '5/12' -> 5; anything unreadable -> 0. */
export function pitchX12Of(pitch: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*\/\s*12\s*$/.exec(pitch);
  return m ? Number(m[1]) : 0;
}

// ---------------------------------------------------------------------------------------------------------
// Runs from a roof.

type Piece = { a: V; b: V; facets: { id: string; m: number }[] };

/** Whether a facet is a low porch or patio roof (see GUTTER_DESIGN). */
function lowAttachmentIds(roof: RoofModel): Set<string> {
  const total = roof.facets.reduce((s, f) => s + f.planSqFt, 0);
  const out = new Set<string>();
  if (roof.facets.length < 2 || total <= 0) return out;
  for (const f of roof.facets) {
    if (pitchX12Of(f.pitch) < GUTTER_DESIGN.lowAttachmentMaxX12 && f.planSqFt / total <= GUTTER_DESIGN.lowAttachmentMaxShare) out.add(f.id);
  }
  // Only when the rest of the roof is sloped: a roof of flat faces has no porch roof to tell apart.
  const sloped = roof.facets.some((f) => !out.has(f.id) && pitchX12Of(f.pitch) >= GUTTER_DESIGN.lowAttachmentMaxX12);
  return sloped ? out : new Set();
}

/** The line oriented with its facet on its left (the facet's middle, else the outline's). */
function orient(line: RoofLine, frame: Frame, facetMid: Map<string, V>, roofMid: V): { a: V; b: V } {
  let a = frame.toLocal(line.coords[0]);
  let b = frame.toLocal(line.coords[1]);
  const id = line.facets?.[0];
  const mid = (id !== undefined ? facetMid.get(id) : undefined) ?? roofMid;
  if (cross(sub(b, a), sub(mid, a)) < 0) [a, b] = [b, a];
  return { a, b };
}

/** Joins pieces that touch end to start and run the same way. */
function mergeCollinear(pieces: Piece[]): Piece[] {
  const out = pieces.map((p) => ({ ...p, facets: [...p.facets] }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = 0; j < out.length; j++) {
        if (i === j) continue;
        const p = out[i]!;
        const q = out[j]!;
        if (near(p.b, q.a) && angleDeg(sub(p.b, p.a), sub(q.b, q.a)) <= COLLINEAR_DEG) {
          p.b = q.b;
          for (const f of q.facets) {
            const have = p.facets.find((x) => x.id === f.id);
            if (have) have.m += f.m;
            else p.facets.push({ ...f });
          }
          out.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return out;
}

/** The downhill edges of a porch roof: its edges facing within 60 degrees of the way it slopes, else its longest. */
function porchEdges(lines: RoofLine[], facet: RoofFacet, frame: Frame, facetMid: Map<string, V>, roofMid: V): RoofLine[] {
  if (lines.length === 0) return [];
  const az = facet.azimuthDeg;
  if (az !== undefined && Number.isFinite(az)) {
    const down: V = { x: Math.sin((az * Math.PI) / 180), y: Math.cos((az * Math.PI) / 180) };
    const facing = lines.filter((l) => {
      const { a, b } = orient(l, frame, facetMid, roofMid);
      const d = sub(b, a);
      return angleDeg({ x: d.y, y: -d.x }, down) <= 60;
    });
    if (facing.length > 0) return facing;
  }
  return [lines.reduce((best, l) => (l.lengthFt > best.lengthFt ? l : best))];
}

/**
 * The gutter runs and corners of a roof (before any adjustment). Eaves only; a porch roof's downhill edges ('eave' or
 * 'flat-edge' of that facet alone) as their own runs. Areas: each facet's plan and sloped areas shared among its runs
 * by length. Facets with no eave of their own (a face draining onto a lower roof's face) are not counted.
 */
export function gutterRuns(roof: RoofModel | null): { runs: GutterRunGeometry[]; corners: GutterCorner[] } {
  if (roof === null || roof.lines.length === 0) return { runs: [], corners: [] };
  const all = [...roof.outline, ...roof.lines.flatMap((l) => l.coords)];
  const frame = frameFor(all);
  const facetMid = new Map(roof.facets.map((f) => [f.id, frame.toLocal(f.labelAt)]));
  const roofMid = centroid(roof.outline.map((p) => frame.toLocal(p)));
  const low = lowAttachmentIds(roof);
  const facetById = new Map(roof.facets.map((f) => [f.id, f]));

  const isLow = (l: RoofLine) => (l.facets ?? []).length === 1 && low.has(l.facets![0]!);
  // A rake that is level (a 3D roof's edge drawn as a rake within its noise) drains like an eave.
  const levelRake = (l: RoofLine) => {
    if (l.kind !== 'rake') return false;
    const planFt = len(sub(frame.toLocal(l.coords[1]), frame.toLocal(l.coords[0]))) * FT_PER_M;
    if (planFt <= 0) return false;
    const riseFt = Math.sqrt(Math.max(0, l.lengthFt * l.lengthFt - planFt * planFt));
    return (riseFt / planFt) * 12 < GUTTER_DESIGN.levelRakeMaxX12;
  };
  const mainLines = roof.lines.filter((l) => (l.kind === 'eave' || levelRake(l)) && !isLow(l));
  const lowLines: RoofLine[] = [];
  for (const id of low) {
    const edges = roof.lines.filter((l) => (l.kind === 'eave' || l.kind === 'flat-edge') && (l.facets ?? []).length === 1 && l.facets![0] === id);
    lowLines.push(...porchEdges(edges, facetById.get(id)!, frame, facetMid, roofMid));
  }

  const toPieces = (lines: RoofLine[]): Piece[] =>
    lines.map((l) => {
      const { a, b } = orient(l, frame, facetMid, roofMid);
      return { a, b, facets: (l.facets ?? []).slice(0, 1).map((id) => ({ id, m: len(sub(b, a)) })) };
    });
  const minM = GUTTER_DESIGN.minRunFt / FT_PER_M;
  const loneM = GUTTER_DESIGN.minLoneRunFt / FT_PER_M;
  // Too short to gutter: noise, or a short piece that turns no corner into another run.
  const keep = (all: Piece[]) => {
    const long = all.filter((p) => len(sub(p.b, p.a)) >= minM);
    return long.filter((p) => len(sub(p.b, p.a)) >= loneM || long.some((q) => q !== p && (near(p.b, q.a) || near(q.b, p.a))));
  };
  const mainPieces = keep(mergeCollinear(toPieces(mainLines)));
  const lowPieces = keep(mergeCollinear(toPieces(lowLines)));
  const byLength = (p: Piece, q: Piece) => len(sub(q.b, q.a)) - len(sub(p.b, p.a)) || p.a.x - q.a.x || p.a.y - q.a.y;
  mainPieces.sort(byLength);
  lowPieces.sort(byLength);
  const pieces = [...mainPieces.map((p) => ({ p, kind: 'main' as const })), ...lowPieces.map((p) => ({ p, kind: 'low-attachment' as const }))];

  // Each facet's eave length, to share its area out.
  const facetEaveM = new Map<string, number>();
  for (const { p } of pieces) for (const f of p.facets) facetEaveM.set(f.id, (facetEaveM.get(f.id) ?? 0) + f.m);

  const runs: GutterRunGeometry[] = pieces.map(({ p, kind }, i) => {
    let planSqFt = 0;
    let slopedSqFt = 0;
    let designSqFt = 0;
    for (const f of p.facets) {
      const facet = facetById.get(f.id);
      const share = facet ? f.m / (facetEaveM.get(f.id) ?? f.m) : 0;
      if (!facet || !(share > 0)) continue;
      planSqFt += facet.planSqFt * share;
      slopedSqFt += facet.areaSqFt * share;
      designSqFt += facet.planSqFt * share * rainPitchFactor(pitchX12Of(facet.pitch));
    }
    const d = sub(p.b, p.a);
    return {
      id: `G${i + 1}`,
      kind,
      coords: [frame.toLngLat(p.a), frame.toLngLat(p.b)],
      lengthFt: round1(len(d) * FT_PER_M),
      side: compassSide({ x: d.y, y: -d.x }),
      facets: p.facets.map((f) => f.id),
      planSqFt: Math.round(planSqFt),
      slopedSqFt: Math.round(slopedSqFt),
      designSqFt: Math.round(designSqFt),
    };
  });

  // Corners: a run's end at another run's start (same kind), turning more than the collinear tolerance.
  const corners: GutterCorner[] = [];
  for (let i = 0; i < pieces.length; i++) {
    for (let j = 0; j < pieces.length; j++) {
      if (i === j || pieces[i]!.kind !== pieces[j]!.kind) continue;
      const p = pieces[i]!.p;
      const q = pieces[j]!.p;
      if (!near(p.b, q.a)) continue;
      const turn = cross(sub(p.b, p.a), sub(q.b, q.a));
      if (angleDeg(sub(p.b, p.a), sub(q.b, q.a)) <= COLLINEAR_DEG) continue;
      corners.push({ at: frame.toLngLat(p.b), kind: turn > 0 ? 'outside' : 'inside', runIds: [runs[i]!.id, runs[j]!.id] });
    }
  }
  return { runs, corners };
}

// ---------------------------------------------------------------------------------------------------------
// Downspouts, size, totals.

function downspoutsFor(run: GutterRunGeometry, n: number, eaveFt: number): Downspout[] {
  const [a, b] = run.coords;
  const at = (t: number): LngLat => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  if (n <= 0) return [];
  // One downspout: at the run's end (going round the house the same way, so neighbouring runs use different corners).
  const ts = n === 1 ? [1] : Array.from({ length: n }, (_, k) => k / (n - 1));
  return ts.map((t) => ({ atFt: round1(run.lengthFt * t), at: at(t), lengthFt: eaveFt }));
}

/** Area reaching one downspout from one side, with n downspouts spread end to end (n 1: all of it to the end). */
function flowArea(designSqFt: number, n: number): number {
  if (n <= 1) return designSqFt;
  return designSqFt / (2 * (n - 1));
}

/** Downspouts a run needs for spacing and capacity at this size. */
function neededDownspouts(run: GutterRunGeometry, designSqFt: number, size: GutterSize): number {
  const spacing = run.lengthFt <= GUTTER_DESIGN.maxDownspoutSpacingFt ? 1 : Math.ceil(run.lengthFt / GUTTER_DESIGN.maxDownspoutSpacingFt) + 1;
  const capacity = Math.ceil(designSqFt / downspoutCapacitySqFt(GUTTER_DESIGN.downspoutFor[size]));
  let n = Math.max(1, spacing, capacity);
  // More downspouts until the gutter itself carries what reaches each one (6 in only: 5 in would be sized up instead).
  while (size === '6in' && n < MAX_DOWNSPOUTS_PER_RUN && flowArea(designSqFt, n) > gutterCapacitySqFt('6in')) n += 1;
  return Math.min(n, MAX_DOWNSPOUTS_PER_RUN);
}

/** Adjustments with only this roof's runs, sane counts and a known size. */
export function cleanGutterAdjustments(runs: readonly { id: string }[], adj: Partial<GutterAdjustments> | null | undefined): GutterAdjustments {
  const ids = new Set(runs.map((r) => r.id));
  const excluded = [...new Set((adj?.excludedRunIds ?? []).filter((id) => ids.has(id)))];
  const downspouts: Record<string, number> = {};
  for (const [id, n] of Object.entries(adj?.downspouts ?? {})) {
    if (ids.has(id) && Number.isFinite(n)) downspouts[id] = Math.max(0, Math.min(MAX_DOWNSPOUTS_PER_RUN, Math.round(n)));
  }
  const size = adj?.size === '5in' || adj?.size === '6in' ? adj.size : null;
  return { excludedRunIds: excluded, downspouts, size };
}

/** "1,420" */
const num = (n: number): string => Math.round(n).toLocaleString('en-US');
const sizeText = (s: GutterSize): string => (s === '5in' ? '5 in' : '6 in');

function sideText(run: GutterRun | GutterRunGeometry): string {
  return run.kind === 'low-attachment' ? `${run.side} porch run` : `${run.side} run`;
}

/** Eave height for downspouts: Google's heights, else floors x 10 ft, else one floor assumed. */
export function eaveHeight(input: { eaveHeightM?: number | null; floors?: number | null }): EaveHeight {
  const m = input.eaveHeightM;
  if (m !== null && m !== undefined && Number.isFinite(m) && m >= 1.8 && m <= 15) {
    const heightFt = round1(m * FT_PER_M);
    return { heightFt, floors: m < 4.5 ? 1 : m < 7.5 ? 2 : 3, source: 'google' };
  }
  const f = input.floors;
  if (f !== null && f !== undefined && Number.isFinite(f) && f >= 1 && f <= 5) {
    const floors = Math.round(f);
    return { heightFt: floors * GUTTER_DESIGN.floorHeightFt, floors, source: 'floors' };
  }
  return { heightFt: GUTTER_DESIGN.floorHeightFt, floors: 1, source: 'assumed' };
}

/**
 * The gutters of a roof with the person's adjustments: runs (left out or not), downspouts, corners, the size and its
 * reason, and the totals of the quoted runs.
 */
export function measureGutters(roof: RoofModel | null, eave: EaveHeight, adjustments?: Partial<GutterAdjustments> | null): GutterMeasure {
  const { runs: geo, corners } = gutterRuns(roof);
  const adj = cleanGutterAdjustments(geo, adjustments);
  const excluded = new Set(adj.excludedRunIds);
  const quoted = (id: string) => !excluded.has(id);
  const liveCorners = corners.filter((c) => quoted(c.runIds[0]) && quoted(c.runIds[1]));

  // A short run turning a corner into a quoted run drains into it (no downspout); its area goes with it.
  const drainsInto = new Map<string, string>();
  for (const r of geo) {
    if (!quoted(r.id) || r.lengthFt >= GUTTER_DESIGN.shortRunFt || adj.downspouts[r.id] !== undefined) continue;
    const c = liveCorners.find((k) => k.runIds.includes(r.id));
    if (!c) continue;
    const other = c.runIds[0] === r.id ? c.runIds[1] : c.runIds[0];
    const o = geo.find((g) => g.id === other)!;
    if (o.lengthFt >= GUTTER_DESIGN.shortRunFt) drainsInto.set(r.id, other);
  }
  const designWithShort = (r: GutterRunGeometry): number =>
    r.designSqFt + geo.filter((g) => drainsInto.get(g.id) === r.id).reduce((s, g) => s + g.designSqFt, 0);

  const eaveFor = (r: GutterRunGeometry) => (r.kind === 'low-attachment' ? Math.min(eave.heightFt, GUTTER_DESIGN.lowAttachmentEaveFt) : eave.heightFt);
  const counts = (size: GutterSize) =>
    new Map(
      geo.map((r) => {
        if (!quoted(r.id)) return [r.id, 0];
        const set = adj.downspouts[r.id];
        if (set !== undefined) return [r.id, set];
        if (drainsInto.has(r.id)) return [r.id, 0];
        return [r.id, neededDownspouts(r, designWithShort(r), size)];
      }),
    );
  const worst = (size: GutterSize) => {
    const n = counts(size);
    let best: { run: GutterRunGeometry; flow: number } | null = null;
    for (const r of geo) {
      if (!quoted(r.id) || drainsInto.has(r.id)) continue;
      const flow = flowArea(designWithShort(r), n.get(r.id) ?? 1);
      if (best === null || flow > best.flow) best = { run: r, flow };
    }
    return best;
  };

  // Recommended: 5 in unless a run sends more to one downspout than 5 in carries.
  const cap5 = gutterCapacitySqFt('5in');
  const cap6 = gutterCapacitySqFt('6in');
  const w5 = worst('5in');
  const recommended: GutterSize = w5 !== null && w5.flow > cap5 ? '6in' : '5in';
  const chosen = adj.size ?? recommended;
  const n = counts(chosen);
  const w = worst(chosen);
  let reason: string;
  if (w === null) reason = `${sizeText(chosen)}: no gutter runs on the quote`;
  else if (recommended === '6in' && w5 !== null)
    reason = `6 in: the ${sideText(w5.run)} sends ${num(w5.flow)} sq ft to one downspout, more than a 5 in gutter carries in an Arkansas downpour (${num(cap5)})`;
  else reason = `5 in: the most any run sends to one downspout is ${num(w.flow)} sq ft (${sideText(w.run)}), within a 5 in gutter's ${num(cap5)}`;
  if (adj.size !== null && adj.size !== recommended) {
    reason =
      adj.size === '5in'
        ? `5 in, chosen by hand: ${num(w?.flow ?? 0)} sq ft reaches one downspout (${w ? sideText(w.run) : 'none'}), over the ${num(cap5)} a 5 in gutter carries`
        : `6 in, chosen by hand (5 in would carry the ${num(w5?.flow ?? 0)} sq ft that reaches one downspout)`;
  } else if (chosen === '6in' && w !== null && w.flow > cap6) {
    reason += `; add downspouts: the ${sideText(w.run)} still sends ${num(w.flow)} sq ft to one`;
  }

  const runs: GutterRun[] = geo.map((r) => {
    const isOut = !quoted(r.id);
    const count = n.get(r.id) ?? 0;
    const myCorners = liveCorners.filter((c) => c.runIds.includes(r.id));
    const joinedStart = liveCorners.some((c) => c.runIds[1] === r.id);
    const joinedEnd = liveCorners.some((c) => c.runIds[0] === r.id);
    const ef = eaveFor(r);
    return {
      ...r,
      excluded: isOut,
      downspouts: isOut ? [] : downspoutsFor(r, count, ef),
      downspoutsSet: adj.downspouts[r.id] !== undefined,
      endCaps: isOut ? 0 : (joinedStart ? 0 : 1) + (joinedEnd ? 0 : 1),
      corners: { inside: myCorners.filter((c) => c.kind === 'inside').length, outside: myCorners.filter((c) => c.kind === 'outside').length },
      flowSqFt: isOut || drainsInto.has(r.id) ? 0 : Math.round(flowArea(designWithShort(r), count)),
      eaveHeightFt: ef,
    };
  });

  const live = runs.filter((r) => !r.excluded);
  const downspouts = live.reduce((s, r) => s + r.downspouts.length, 0);
  const totals: GutterTotals = {
    runs: live.length,
    gutterFt: round1(live.reduce((s, r) => s + r.lengthFt, 0)),
    downspouts,
    downspoutFt: round1(live.reduce((s, r) => s + r.downspouts.reduce((t, d) => t + d.lengthFt, 0), 0)),
    insideCorners: liveCorners.filter((c) => c.kind === 'inside').length,
    outsideCorners: liveCorners.filter((c) => c.kind === 'outside').length,
    endCaps: live.reduce((s, r) => s + r.endCaps, 0),
    hangers: live.reduce((s, r) => s + Math.ceil(r.lengthFt / GUTTER_DESIGN.hangerSpacingFt), 0),
    outlets: downspouts,
    elbows: downspouts * GUTTER_DESIGN.elbowsPerDownspout,
    designSqFt: live.reduce((s, r) => s + r.designSqFt, 0),
  };
  return {
    runs,
    corners,
    size: { recommended, chosen, downspout: GUTTER_DESIGN.downspoutFor[chosen], reason, overridden: adj.size !== null },
    eave,
    totals,
    design: {
      rainfallInPerHr: GUTTER_DESIGN.rainfallInPerHr,
      rainfallSource: GUTTER_DESIGN.rainfallSource,
      capacitySqFt: { '5in': Math.round(cap5), '6in': Math.round(cap6) },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Pricing.

/** Installed prices for one tier, cents. */
export type GutterTier = {
  tier: Tier;
  name: string;
  description: string;
  size: GutterSize;
  guards: boolean;
  perFtCents: number;
  downspoutPerFtCents: number;
  cornerCents: number;
  guardPerFtCents: number;
  enabled: boolean;
};

/**
 * Default installed prices (cents), a starting point a company changes: seamless aluminum K-style, installed, including
 * hangers, end caps and outlets in the per-foot price. Set from typical 2025-2026 US installed ranges (5 in seamless
 * aluminum about $6-12/ft, 6 in about $8-15/ft, downspouts about $6-12/ft, mesh guards about $7-12/ft); mid-low of
 * each range for a mid-South market. Not quotes from any supplier.
 */
export const DEFAULT_GUTTER_TIERS: readonly GutterTier[] = [
  {
    tier: 'good',
    name: '5" seamless aluminum',
    description: 'K-style, 2x3 downspouts, hidden hangers every 2 ft',
    size: '5in',
    guards: false,
    perFtCents: 900,
    downspoutPerFtCents: 800,
    cornerCents: 2_500,
    guardPerFtCents: 0,
    enabled: true,
  },
  {
    tier: 'better',
    name: '6" seamless aluminum',
    description: 'K-style, 3x4 downspouts, carries 44% more water',
    size: '6in',
    guards: false,
    perFtCents: 1_150,
    downspoutPerFtCents: 1_000,
    cornerCents: 3_000,
    guardPerFtCents: 0,
    enabled: true,
  },
  {
    tier: 'best',
    name: '6" seamless + gutter guards',
    description: '6 in K-style, 3x4 downspouts, micro-mesh guards on every run',
    size: '6in',
    guards: true,
    perFtCents: 1_150,
    downspoutPerFtCents: 1_000,
    cornerCents: 3_000,
    guardPerFtCents: 900,
    enabled: true,
  },
];

export type GutterQuoteLineKind = 'gutter' | 'downspout' | 'corner' | 'guard';
export type GutterQuoteLine = { kind: GutterQuoteLineKind; quantity: number; unit: 'ft' | 'each'; unitCents: number; amountCents: number };
export type GutterQuote = {
  tier: Tier;
  name: string;
  description: string;
  size: GutterSize;
  guards: boolean;
  /** This tier's size is smaller than the recommended one. */
  belowRecommended: boolean;
  lines: GutterQuoteLine[];
  totalCents: number;
};

/**
 * One quote per enabled tier from the quoted runs (runs on adjustments.excludedRunIds are left out): gutter feet,
 * downspout feet, corners (miters between two quoted runs) and, with guards, guard feet. The downspout layout is the
 * measured one for every tier.
 */
export function priceGutters(
  measured: Pick<GutterMeasure, 'runs' | 'corners' | 'size'>,
  adjustments?: Partial<GutterAdjustments> | null,
  tiers: readonly GutterTier[] = DEFAULT_GUTTER_TIERS,
): GutterQuote[] {
  const excluded = new Set([...(adjustments?.excludedRunIds ?? []), ...measured.runs.filter((r) => r.excluded).map((r) => r.id)]);
  const live = measured.runs.filter((r) => !excluded.has(r.id));
  const ft = round1(live.reduce((s, r) => s + r.lengthFt, 0));
  const dsFt = round1(live.reduce((s, r) => s + r.downspouts.reduce((t, d) => t + d.lengthFt, 0), 0));
  const corners = measured.corners.filter((c) => !excluded.has(c.runIds[0]) && !excluded.has(c.runIds[1])).length;
  return tiers
    .filter((t) => t.enabled)
    .map((t) => {
      const line = (kind: GutterQuoteLineKind, quantity: number, unit: 'ft' | 'each', unitCents: number): GutterQuoteLine => ({
        kind,
        quantity,
        unit,
        unitCents,
        amountCents: Math.round(quantity * unitCents),
      });
      const lines = [
        line('gutter', ft, 'ft', t.perFtCents),
        line('downspout', dsFt, 'ft', t.downspoutPerFtCents),
        line('corner', corners, 'each', t.cornerCents),
        ...(t.guards ? [line('guard', ft, 'ft', t.guardPerFtCents)] : []),
      ].filter((l) => l.quantity > 0);
      return {
        tier: t.tier,
        name: t.name,
        description: t.description,
        size: t.size,
        guards: t.guards,
        belowRecommended: t.size === '5in' && measured.size.recommended === '6in',
        lines,
        totalCents: lines.reduce((s, l) => s + l.amountCents, 0),
      };
    });
}

// ---------------------------------------------------------------------------------------------------------
// The API's view.

/** GET/PATCH /api/measurements/:id/gutters. Quotes are null for members who do not see money. */
export type GutterMeasurementView = GutterMeasure & {
  measurementId: string;
  adjustments: GutterAdjustments;
  /** Rakes, drawn greyed beside the gutters. */
  rakes: [LngLat, LngLat][];
  quotes: GutterQuote[] | null;
};

/** PATCH body. */
export type GutterAdjustmentsPatch = Partial<GutterAdjustments>;

/** The whole view from a roof (the API's answer, and the screen's live preview between saves). */
export function gutterView(
  measurementId: string,
  roof: RoofModel | null,
  eave: EaveHeight,
  adjustments: Partial<GutterAdjustments> | null | undefined,
  tiers: readonly GutterTier[] | null = DEFAULT_GUTTER_TIERS,
): GutterMeasurementView {
  const m = measureGutters(roof, eave, adjustments);
  const adj = cleanGutterAdjustments(m.runs, adjustments);
  return {
    ...m,
    measurementId,
    adjustments: adj,
    rakes: (roof?.lines ?? []).filter((l) => l.kind === 'rake').map((l) => [l.coords[0], l.coords[1]] as [LngLat, LngLat]),
    quotes: tiers === null ? null : priceGutters(m, adj, tiers),
  };
}

// Instant estimate from roof outlines (spec 3.2). Pure: no I/O, no UI text, never throws.
import { minRotatedRectangle, perimeterFt, polygonAreaSqFt, pitchFactor } from './roof-geometry.ts';

export * from './roof-geometry.ts';

export type LngLat = [number, number];
export type Ring = LngLat[];
export type Outline = Ring[];
export type InstantInput = { outline: Outline; pitchX12: number; overhangFt: number; valleyFt?: number };
export type InstantEstimate = { footprintSqFt: number; planSqFt: number; surfaceSqFt: number; squares: number; edgeFt: number; ridgeFt: number; valleyFt: number; pitchX12: number };

// Allowance, not an exact offset: for a rectangle-like ring, pushing each of the four sides
// out by the overhang lengthens each side by 2 * overhang (extended at both ends), so the
// offset perimeter is perimeter + 8 * overhang. Irregular rings get the same allowance.
const EDGE_ALLOWANCE_PER_OVERHANG = 8;

// Round to one decimal (areas in sq ft, lengths in 0.1 ft).
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

// Finite, non-negative value; anything else (NaN, Infinity, negative, missing) becomes 0.
function nonNegative(x: number | undefined): number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0;
}

export function instantEstimate(i: InstantInput): InstantEstimate {
  const pitchX12 = nonNegative(i.pitchX12);
  const overhangFt = nonNegative(i.overhangFt);
  const valleyFt = nonNegative(i.valleyFt);
  const factor = pitchFactor(pitchX12);

  // Sums stay unrounded; rounding happens once at the end.
  let footprint = 0;
  let plan = 0;
  let surface = 0;
  let edge = 0;
  let ridge = 0;
  for (const ring of i.outline ?? []) {
    const footprintR = polygonAreaSqFt(ring);
    const perimR = perimeterFt(ring);
    const planR = footprintR + perimR * overhangFt;
    footprint += footprintR;
    plan += planR;
    surface += planR * factor;
    edge += perimR + EDGE_ALLOWANCE_PER_OVERHANG * overhangFt;
    ridge += minRotatedRectangle(ring).longFt;
  }

  return {
    footprintSqFt: round1(footprint),
    planSqFt: round1(plan),
    surfaceSqFt: round1(surface),
    squares: round1(surface / 100),
    edgeFt: round1(edge),
    ridgeFt: round1(ridge),
    valleyFt: round1(valleyFt),
    pitchX12,
  };
}

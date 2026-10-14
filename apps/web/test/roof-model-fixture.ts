import type { RoofModel } from '../src/features/measure/lift/roofModel.ts';

/**
 * A gable roof over a ring's bounding box (south-west, south-east, north-east, north-west): two facets split by an
 * east-west ridge, two eaves (south and north) and two rakes (east and west). Areas are given, not computed.
 */
export function gableRoof(ring: [number, number][], over: Partial<RoofModel['totals']> = {}): RoofModel {
  const [sw, se, ne, nw] = ring as [[number, number], [number, number], [number, number], [number, number]];
  const midW: [number, number] = [sw[0], (sw[1] + nw[1]) / 2];
  const midE: [number, number] = [se[0], (se[1] + ne[1]) / 2];
  const center = (pts: [number, number][]): [number, number] => [
    pts.reduce((s, p) => s + p[0], 0) / pts.length,
    pts.reduce((s, p) => s + p[1], 0) / pts.length,
  ];
  const south: [number, number][] = [sw, se, midE, midW];
  const north: [number, number][] = [midW, midE, ne, nw];
  return {
    facets: [
      { id: 'f1', ring: south, planSqFt: 600, areaSqFt: 671, pitch: '6/12', labelAt: center(south) },
      { id: 'f2', ring: north, planSqFt: 600, areaSqFt: 671, pitch: '6/12', labelAt: center(north) },
    ],
    lines: [
      { kind: 'ridge', coords: [midW, midE], lengthFt: 30, facets: ['f1', 'f2'] },
      { kind: 'eave', coords: [sw, se], lengthFt: 30, facets: ['f1'] },
      { kind: 'eave', coords: [nw, ne], lengthFt: 30, facets: ['f2'] },
      { kind: 'rake', coords: [sw, nw], lengthFt: 45, facets: ['f1', 'f2'] },
      { kind: 'rake', coords: [se, ne], lengthFt: 45, facets: ['f1', 'f2'] },
    ],
    outline: ring,
    pitch: '6/12',
    totals: {
      squares: 13.4,
      slopedSqFt: 1342,
      planSqFt: 1200,
      facetCount: 2,
      wastePct: 10,
      ridgeFt: 30,
      hipFt: 0,
      valleyFt: 0,
      eaveFt: 60,
      rakeFt: 90,
      ...over,
    },
  };
}

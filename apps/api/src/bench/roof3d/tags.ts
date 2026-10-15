import type { LoadedHouse } from './data.ts';
import { canopyStats } from './canopy.ts';
import { roundHalfEven } from './geometry.ts';
import type { CanopyClass, HouseEntry, Thresholds } from './manifest.ts';
import { dominantPitch } from './truth.ts';

/*
 * The cohort tags of a house, derived once from its data and frozen in the manifest. See docs/roof-3d/benchmark.md
 * for why each threshold is where it is.
 */

export const DEFAULT_THRESHOLDS: Thresholds = {
  heavyRim: 0.3,
  heavyRoof: 0.03,
  heavyBite: 0.1,
  lightRim: 0.1,
  lightRoof: 0.01,
  lightBite: 0.03,
  simpleMaxFaces: 6,
  simpleMaxGoogleSegments: 5,
  lowSlopeMaxPitchX12: 3,
  lowSlopeMinSqFt: 80,
  steepMinPitchX12: 10,
};

const SQ_FT_PER_M2 = 10.7639104167;
const x12 = (deg: number) => 12 * Math.tan((deg * Math.PI) / 180);

export function canopyClass(roofShare: number, rimShare: number, biteShare: number, t: Thresholds): CanopyClass {
  if (rimShare >= t.heavyRim || roofShare >= t.heavyRoof || biteShare >= t.heavyBite) return 'heavy';
  if (rimShare >= t.lightRim || roofShare >= t.lightRoof || biteShare >= t.lightBite) return 'light';
  return 'none';
}

export function tagsOf(h: LoadedHouse, t: Thresholds): HouseEntry['tags'] {
  const stats = canopyStats(h.layers, h.entry.point);
  const segs = (h.building?.segments ?? []).filter((s) => s.groundAreaM2 >= 2);
  const ev = h.eagleview;
  const googleMain = dominantPitch(segs.map((s) => ({ pitch: x12(s.pitchDeg), area: s.areaM2 })));
  const mainPitchX12 = ev !== null ? dominantPitch(ev.faces.map((f) => ({ pitch: f.pitch_x12 ?? 0, area: f.sloped_sqft ?? 0 }))) : googleMain;
  const lowSlope =
    ev !== null
      ? ev.faces.some((f) => (f.pitch_x12 ?? 99) <= t.lowSlopeMaxPitchX12 && (f.sloped_sqft ?? 0) >= t.lowSlopeMinSqFt)
      : segs.some((s) => roundHalfEven(x12(s.pitchDeg)) <= t.lowSlopeMaxPitchX12 && s.areaM2 * SQ_FT_PER_M2 >= t.lowSlopeMinSqFt);
  return {
    canopy: stats === null ? null : { roofShare: Math.round(stats.roofShare * 1000) / 1000, rimShare: Math.round(stats.rimShare * 1000) / 1000, biteShare: Math.round(stats.biteShare * 1000) / 1000, class: canopyClass(stats.roofShare, stats.rimShare, stats.biteShare, t) },
    complexity:
      ev !== null
        ? { class: ev.faces.length <= t.simpleMaxFaces ? 'simple' : 'complex', faces: ev.faces.length, source: 'eagleview' }
        : { class: segs.length <= t.simpleMaxGoogleSegments ? 'simple' : 'complex', faces: segs.length, source: 'google-segments' },
    lowSlope,
    steep: mainPitchX12 !== null && mainPitchX12 >= t.steepMinPitchX12,
    mainPitchX12,
    pitchSource: ev !== null ? 'eagleview' : 'google-segments',
  };
}

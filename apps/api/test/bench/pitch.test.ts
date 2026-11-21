import { describe, expect, it } from 'vitest';
import type { LngLat, Roof3d } from '@roofline/shared';
import { GOOGLE_PITCH_OFFSET_X12, roofOnLayers } from '../../src/estimator/roof-3d.ts';
import { checkRoof, differsFromGoogle } from '../../src/estimator/roof-3d-compare.ts';
import { hipLayers } from '../roof-3d-fixture.ts';

/*
 * The pitch track (docs/roof-3d/pitch.md): the server reports pooled pitches less the calibration of Google's height
 * maps, and both can be turned off through the benchmark's tuning. No database: these run in the roof-bench project.
 */

/** A house about 25 m by 22 m with a hip roof (the measurements test's). */
const HOUSE: LngLat[] = [
  [-96.0, 41.25],
  [-95.9997, 41.25],
  [-95.9997, 41.2502],
  [-96.0, 41.2502],
  [-96.0, 41.25],
];
const INSIDE: LngLat = [-95.99985, 41.2501];

describe('the pitch the server reports on Google\'s height maps', () => {
  const layers = hipLayers(HOUSE, { pitchX12: 7 });
  const served = roofOnLayers(layers, INSIDE)!;
  const uncalibrated = roofOnLayers(layers, INSIDE, { tuning: { pitch: { offsetX12: 0 } } })!;
  const asFitted = roofOnLayers(layers, INSIDE, { tuning: { pitch: { pool: false, offsetX12: 0 } } })!;

  it('takes the calibration off every face: a height map reading 7/12 is reported 0.25 lower', () => {
    expect(GOOGLE_PITCH_OFFSET_X12).toBe(0.25);
    expect(served.faces).toHaveLength(4);
    served.faces.forEach((f, k) => {
      expect(f.pitchX12).toBeCloseTo(uncalibrated.faces[k]!.pitchX12 - GOOGLE_PITCH_OFFSET_X12, 2);
      expect(Math.abs(f.pitchX12 - (7 - GOOGLE_PITCH_OFFSET_X12))).toBeLessThan(0.15);
      // The sloped area stays with the pitch before the calibration (PitchParams.offsetArea is off)...
      expect(f.slopedAreaSqFt).toBe(uncalibrated.faces[k]!.slopedAreaSqFt);
      expect(f.slopedAreaSqFt / f.planAreaSqFt).toBeCloseTo(Math.hypot(1, uncalibrated.faces[k]!.pitchX12 / 12), 2);
    });
    // ...and follows it when asked to.
    const follow = roofOnLayers(layers, INSIDE, { tuning: { pitch: { offsetArea: true } } })!;
    follow.faces.forEach((f, k) => {
      expect(f.pitchX12).toBe(served.faces[k]!.pitchX12);
      expect(f.slopedAreaSqFt).toBeLessThan(served.faces[k]!.slopedAreaSqFt);
      expect(f.slopedAreaSqFt / f.planAreaSqFt).toBeCloseTo(Math.hypot(1, f.pitchX12 / 12), 2);
    });
  });

  it('pools the four faces of the hip to one pitch, where each face alone reads its own', () => {
    const pooled = new Set(uncalibrated.faces.map((f) => f.pitchX12));
    expect(pooled.size).toBe(1);
    expect(new Set(asFitted.faces.map((f) => f.pitchX12)).size).toBeGreaterThan(1);
    for (const f of asFitted.faces) expect(Math.abs(f.pitchX12 - 7)).toBeLessThan(0.15);
  });

  it('leaves the outline, the faces\' rings and every line as they were', () => {
    expect(served.outline).toEqual(asFitted.outline);
    expect(served.lines).toEqual(asFitted.lines);
    expect(served.faces.map((f) => f.ring)).toEqual(asFitted.faces.map((f) => f.ring));
    expect(served.faces.map((f) => f.planAreaSqFt)).toEqual(asFitted.faces.map((f) => f.planAreaSqFt));
  });

  it('keeps each face\'s own fitted pitch beside the reported one, only where they differ', () => {
    served.faces.forEach((f, k) => {
      expect(f.fitPitchX12).toBe(asFitted.faces[k]!.pitchX12);
      expect(Math.abs(f.fitPitchX12! - 7)).toBeLessThan(0.15);
    });
    for (const f of asFitted.faces) expect(f.fitPitchX12).toBeUndefined();
  });

  it('Google\'s segment is held against the fitted plane: a face whose reported pitch was pooled away from it still agrees', () => {
    // Google's own fit of the same heights: 7/12 under every face, each segment as big as the face over it.
    const seven = (Math.atan(7 / 12) * 180) / Math.PI;
    const building = { center: INSIDE, box: null, segments: served.faces.map((f) => ({ center: f.labelAt, pitchDeg: seven, azimuthDeg: f.azimuthDeg, groundAreaM2: f.planAreaSqFt / 10.7639104167 })) } as never;
    // The same roof as it would be stored had pooling and calibration moved every face 1.3/12 from its plane.
    const moved: Roof3d = { ...served, faces: served.faces.map((f) => ({ ...f, pitchX12: f.fitPitchX12! - 1.3 })) };
    expect(checkRoof(moved, building).rows.every((r) => r.main && r.pitchOk)).toBe(true);
    expect(differsFromGoogle(moved, building)).toBe(false);
    // Without the fitted pitch on the face (a roof stored before), the reported one is all there is to compare.
    const old: Roof3d = { ...moved, faces: moved.faces.map(({ fitPitchX12: _fit, ...f }) => f) };
    expect(checkRoof(old, building).rows.every((r) => !r.pitchOk)).toBe(true);
    // And a plane that really differs from Google's still fails, whatever is reported.
    const off: Roof3d = { ...served, faces: served.faces.map((f) => ({ ...f, pitchX12: 7, fitPitchX12: 9 })) };
    expect(differsFromGoogle(off, building)).toBe(true);
  });
});

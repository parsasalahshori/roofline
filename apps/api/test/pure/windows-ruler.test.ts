import type { StoredFacadePhoto } from '@roofline/db';
import type { DoorRuler } from '@roofline/shared';
import { describe, expect, it } from 'vitest';
import { type Camera, METRES_TO_INCHES, project, type Vec, wallsOf } from '../../src/estimator/windows-geometry.ts';
import { correctedCamera, mainWall } from '../../src/estimator/windows-lineup.ts';
import { applyRuler, type Plan, rawCamera, sizeOnPhoto } from '../../src/estimator/windows-view.ts';

/*
 * A door as a ruler (pure). The outline's front wall is 16 m north of where the camera is stored; the real camera is
 * further back (Street View's position, or the outline, a few metres off), so everything on the photo sizes small. A
 * door of known size on the wall gives the camera's real distance; every marked window is then sized right. A front
 * door set back in a porch breaks the ruler's assumption (flush with the wall): its windows come out too big.
 */

const RING: Vec[] = [
  [-7, 16],
  [7, 16],
  [7, 25],
  [-7, 25],
];
const plan: Plan = { walls: wallsOf(RING), camera: [0, 0], toLocal: (p) => [p[0], p[1]] };
const photo: StoredFacadePhoto = {
  id: '00000000-0000-4000-8000-000000000001',
  heading: 2,
  fov: 60,
  widthPx: 640,
  heightPx: 640,
  capturedOn: '2025-06',
  distanceM: 16,
  key: null,
  fetchedAt: '2026-10-16T00:00:00.000Z',
  deleteBy: '2026-11-15T00:00:00.000Z',
  pitch: 4,
  measure: true,
  range: [300, 60],
  lineup: null,
  personFit: null,
};
const stored = rawCamera(plan, photo)!;
const WALL = mainWall(plan.walls, stored.pos)!;

/** The photo box of a w x h (m) rectangle at x (m east of the middle) on a plane `depth` m north, sill at `sill`. */
function boxOn(cam: Camera, x: number, w: number, sill: number, h: number, depth = 16) {
  const pts = [
    [x, sill],
    [x + w, sill],
    [x, sill + h],
    [x + w, sill + h],
  ].map(([px, z]) => project(cam, [px!, depth, z!])!);
  const xs = pts.map((p) => p[0] / 640);
  const ys = pts.map((p) => p[1] / 640);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** The true camera: 30% further from the wall than stored. */
const TRUE_CAM = correctedCamera(stored, WALL, 0, 1.3);
const GARAGE = { widthIn: 192, heightIn: 84 };
const garageBox = boxOn(TRUE_CAM, -6, GARAGE.widthIn / METRES_TO_INCHES, 0, GARAGE.heightIn / METRES_TO_INCHES);
const windowBox = boxOn(TRUE_CAM, 2, 0.9144, 0.9, 1.524); // a 36 x 60 in window
const ruler = (o: Partial<DoorRuler> = {}): DoorRuler => ({ photoId: photo.id, box: garageBox, kind: 'garage-door', ...GARAGE, ...o });

describe('a door as a ruler', () => {
  it('without it, a camera 30% further than stored sizes everything about 23% small', () => {
    const w = sizeOnPhoto(plan, photo, windowBox)!;
    expect(w.widthIn / 36).toBeGreaterThan(0.72);
    expect(w.widthIn / 36).toBeLessThan(0.82);
    expect(w.heightIn / 60).toBeLessThan(0.82);
  });

  it("a flush garage door of known size recovers the camera's distance; the windows on its photo come out right", () => {
    const applied = applyRuler(plan, photo, ruler())!;
    expect(applied).not.toBeNull();
    expect(applied.result.scale).toBeGreaterThan(1.25);
    expect(applied.result.scale).toBeLessThan(1.35);
    expect(applied.result.agreement).toBe('good');
    expect(applied.result.rangeM.after / applied.result.rangeM.before).toBeGreaterThan(1.2);
    const w = sizeOnPhoto(plan, photo, windowBox, applied.camera)!;
    expect(Math.abs(w.widthIn - 36)).toBeLessThanOrEqual(1);
    expect(Math.abs(w.heightIn - 60)).toBeLessThanOrEqual(1.5);
    const door = sizeOnPhoto(plan, photo, garageBox, applied.camera)!;
    expect(Math.abs(door.widthIn - 192)).toBeLessThanOrEqual(2);
    expect(Math.abs(door.heightIn - 84)).toBeLessThanOrEqual(2);
  });

  it('a front door 1.5 m back in a porch, taken as flush, makes the windows too big (prefer the garage door)', () => {
    const doorBox = boxOn(TRUE_CAM, -0.5, 0.9144, 0, 2.032, 17.5);
    const applied = applyRuler(plan, photo, ruler({ kind: 'front-door', box: doorBox, widthIn: 36, heightIn: 80 }))!;
    const w = sizeOnPhoto(plan, photo, windowBox, applied.camera)!;
    expect(w.widthIn).toBeGreaterThan(38);
    expect(w.heightIn).toBeGreaterThan(63);
  });

  it("width and height that disagree (the box is not on the door's edges) say check", () => {
    expect(applyRuler(plan, photo, ruler({ heightIn: 84 * 1.4 }))!.result.agreement).toBe('check');
  });

  it('a size the photo cannot be scaled to (more than x3) is refused', () => {
    expect(applyRuler(plan, photo, ruler({ widthIn: GARAGE.widthIn * 4, heightIn: GARAGE.heightIn * 4 }))).toBeNull();
    expect(applyRuler(plan, photo, ruler({ widthIn: GARAGE.widthIn / 4, heightIn: GARAGE.heightIn / 4 }))).toBeNull();
  });

  it('a camera closer than stored works the other way (the door comes out too big without the ruler)', () => {
    const near = correctedCamera(stored, WALL, 0, 0.8);
    const box = boxOn(near, -6, 192 / METRES_TO_INCHES, 0, 84 / METRES_TO_INCHES);
    const applied = applyRuler(plan, photo, ruler({ box }))!;
    expect(applied.result.scale).toBeLessThan(0.85);
    const w = sizeOnPhoto(plan, photo, boxOn(near, 2, 0.9144, 0.9, 1.524), applied.camera)!;
    expect(Math.abs(w.widthIn - 36)).toBeLessThanOrEqual(1);
  });
});

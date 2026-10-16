import type { StoredFacadePhoto } from '@roofline/db';
import { describe, expect, it } from 'vitest';
import { type Camera, METRES_TO_INCHES, project, wallsOf } from '../../src/estimator/windows-geometry.ts';
import { decodeGray, type LineUp, lineUp, sobel } from '../../src/estimator/windows-lineup.ts';
import { applyRuler, type Plan, sizeOnPhoto } from '../../src/estimator/windows-view.ts';
import { EAVE, RING, type Scene, scene, TRUE, WALL } from './facade-scenes.ts';

/*
 * Camera pitch and roll in the line-up (pure). Live Street View photos sit a few degrees off in pitch (the car-mounted
 * camera's pitch reference; about 3.5 degrees on the owner's houses) and can roll a little; the stored camera does not
 * know. Synthetic renders taken with the camera pitched and rolled by a known amount: the line-up, given the stored
 * camera, must find the pitch and roll within 0.3 degrees and say 'good' on clean walls; walls with distractors stay
 * not 'good' with the extra freedom; and a window marked on a pitched photo is sized within 3% once the line-up's
 * corrections are used (and a door ruler on it agrees).
 */

const edgesOf = (bytes: Uint8Array) => sobel(decodeGray(bytes)!);
/** The real camera: the stored one (TRUE) off by these corrections. */
const real = (dp: number, dr: number, dh = 0): Camera => ({ ...TRUE, pitch: TRUE.pitch + dp, roll: dr, heading: TRUE.heading + dh });

describe('the line-up finds the camera pitch and roll', () => {
  it.each([
    ['3.5 degrees pitch, 1 degree roll', 3.5, 1, 0],
    ['-3 degrees pitch, -1.5 degrees roll, 2 degrees heading', -3, -1.5, 2],
    ['5 degrees pitch, 0.5 degree roll, -3 degrees heading', 5, 0.5, -3],
    ['2.2 degrees pitch alone', 2.2, 0, 0],
  ])('%s: recovered within 0.3 degrees, and the wall lines up', (_name, dp, dr, dh) => {
    const r = lineUp(edgesOf(scene({ texture: 30 }, real(dp, dr, dh)).bytes), TRUE, WALL, EAVE, { heightKnown: true });
    expect(r.fit, r.failed.join(',')).toBe('good');
    expect(Math.abs(r.pitchCorrectionDeg - dp)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(r.rollCorrectionDeg - dr)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(r.headingCorrectionDeg - dh)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(r.eaveM! - EAVE) / EAVE).toBeLessThan(0.05);
  });

  const garage = { x0: -6, x1: -0.5, heightM: 2.13, panels: 3 };
  it.each([
    ['a smooth wall', {}],
    ['a wall with a garage door on it', { garage }],
    ['a wall with windows', { windows: [{ x0: 1, x1: 2.2, sill: 0.9, head: 2.3 }, { x0: 3.5, x1: 4.7, sill: 0.9, head: 2.3 }] }],
    ['a wall behind porch posts', { porch: { depthM: 1.8, posts: [-1, 2.5], beamM: 2.6 } }],
  ] as [string, Scene][])('clean, pitched 3.5 and rolled 1: %s lines up', (_name, s) => {
    const r = lineUp(edgesOf(scene(s, real(3.5, 1)).bytes), TRUE, WALL, EAVE, { heightKnown: true });
    expect(r.fit, r.failed.join(',')).toBe('good');
    expect(Math.abs(r.pitchCorrectionDeg - 3.5)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(r.rollCorrectionDeg - 1)).toBeLessThanOrEqual(0.3);
  });

  it('a 15% eave height error on top of the pitch is found too (pitch moves the whole wall, the eave height only its top)', () => {
    const r = lineUp(edgesOf(scene({ texture: 30 }, real(3.5, 1)).bytes), TRUE, WALL, EAVE / 1.15);
    expect(r.fit, r.failed.join(',')).toBe('good');
    expect(Math.abs(r.pitchCorrectionDeg - 3.5)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(r.eaveM! - EAVE) / EAVE).toBeLessThan(0.05);
  });

  it('a pitch beyond the search (8 degrees) is not confirmed', () => {
    const r = lineUp(edgesOf(scene({ texture: 30 }, real(8, 0)).bytes), TRUE, WALL, EAVE, { heightKnown: true });
    expect(r.fit).not.toBe('good');
  });
});

describe('distractors stay not good with pitch and roll free', () => {
  const pitched = real(3.5, 1);
  it.each([
    ['garage panels where the drawn wall falls (house 5 m back)', { realOffsetM: 5, garage: { x0: -7, x1: 0, heightM: 2.13, panels: 3 } }],
    ['porch posts and a beam where the wall is drawn (house 4 m back)', { realOffsetM: 4, porch: { depthM: 4, posts: [-7, 7], beamM: 2.6 } }],
    ['a wider house further back with a garage door', { realOffsetM: 6, realWidenM: 3, garage: { x0: -9, x1: -1, heightM: 2.13, panels: 4 } }],
    ['no eave edge, a full-width garage door', { noRoof: true, garage: { x0: -7, x1: 7, heightM: 2.6, panels: 4 } }],
    ['a garden wall in front (house 3 m back)', { realOffsetM: 3, fence: { x0: -7, x1: 7, heightM: 1.8, depthM: 3 } }],
  ] as [string, Scene][])('%s: never good', (_name, s) => {
    const edges = edgesOf(scene(s, pitched).bytes);
    for (const heightKnown of [true, false]) {
      const r = lineUp(edges, TRUE, WALL, EAVE, { heightKnown });
      expect(r.fit, `heightKnown ${heightKnown}`).not.toBe('good');
      expect(r.failed.length).toBeGreaterThan(0);
    }
  });

  it('the wrong building (the house further along the street, a fence and a garage door in its place): never good', () => {
    for (const turn of [7, 9, -9]) {
      const bytes = scene({ garage: { x0: -6, x1: -0.5, heightM: 2.13, panels: 3 }, fence: { x0: 7.5, x1: 14, heightM: 1.8, depthM: 0 }, seed: 5 }, real(3.5, 1, turn)).bytes;
      const r = lineUp(edgesOf(bytes), TRUE, WALL, EAVE, { heightKnown: true });
      expect(r.fit, `turn ${turn}`).not.toBe('good');
    }
  });
});

describe('sizing on a pitched photo', () => {
  const plan: Plan = { walls: wallsOf(RING), camera: [0, 0], toLocal: (p) => [p[0], p[1]] };
  const cam = real(3.5, 1);
  /** What a person marks: the box through the middles of a w x h (m) rectangle's edges on the wall (16 m north). */
  const marked = (x: number, w: number, sill: number, h: number) => {
    const p = (px: number, z: number) => project(cam, [px, 16, z])!;
    const left = p(x, sill + h / 2)[0];
    const right = p(x + w, sill + h / 2)[0];
    const top = p(x + w / 2, sill + h)[1];
    const bottom = p(x + w / 2, sill)[1];
    return { x: left / 640, y: top / 640, w: (right - left) / 640, h: (bottom - top) / 640 };
  };
  const photo = (lineup: LineUp | null): StoredFacadePhoto => ({
    id: '00000000-0000-4000-8000-000000000002',
    heading: TRUE.heading,
    fov: TRUE.fov,
    widthPx: 640,
    heightPx: 640,
    capturedOn: '2025-06',
    distanceM: 16,
    key: null,
    fetchedAt: '2026-10-16T00:00:00.000Z',
    deleteBy: '2026-11-15T00:00:00.000Z',
    pitch: TRUE.pitch,
    measure: true,
    range: [300, 60],
    lineup: lineup === null ? null : { headingCorrectionDeg: lineup.headingCorrectionDeg, pitchCorrectionDeg: lineup.pitchCorrectionDeg, rollCorrectionDeg: lineup.rollCorrectionDeg, eaveM: lineup.eaveM },
    personFit: null,
  });
  const r = lineUp(edgesOf(scene({ texture: 30 }, cam).bytes), TRUE, WALL, EAVE, { heightKnown: true });

  it('a 36 x 60 in window (sill 0.9 m) and a 72 x 48 in one high on the wall are sized within 3%, on the right floor', () => {
    expect(r.fit).toBe('good');
    for (const [x, w, sill, h, floor] of [
      [2, 36, 0.9, 60, 1],
      [-5, 72, 1.2, 48, 1],
    ] as const) {
      const s = sizeOnPhoto(plan, photo(r), marked(x, w / METRES_TO_INCHES, sill, h / METRES_TO_INCHES))!;
      expect(Math.abs(s.widthIn - w) / w).toBeLessThan(0.03);
      expect(Math.abs(s.heightIn - h) / h).toBeLessThan(0.03);
      expect(s.floor).toBe(floor);
    }
  });

  it('a door ruler on the pitched photo, with the line-up, finds the camera where it is stored and agrees', () => {
    const garage = marked(-6, 192 / METRES_TO_INCHES, 0, 84 / METRES_TO_INCHES);
    const applied = applyRuler(plan, photo(r), { photoId: photo(r).id, box: garage, kind: 'garage-door', widthIn: 192, heightIn: 84 })!;
    expect(applied.result.agreement).toBe('good');
    expect(Math.abs(applied.result.scale - 1)).toBeLessThan(0.03);
    const s = sizeOnPhoto(plan, photo(r), marked(2, 36 / METRES_TO_INCHES, 0.9, 60 / METRES_TO_INCHES), applied.camera)!;
    expect(Math.abs(s.widthIn - 36) / 36).toBeLessThan(0.03);
    expect(Math.abs(s.heightIn - 60) / 60).toBeLessThan(0.03);
  });
});

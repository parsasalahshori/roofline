import { describe, expect, it } from 'vitest';
import {
  angleDiff,
  bearing,
  CAMERA_HEIGHT_M,
  type Camera,
  facadeRegion,
  floorOf,
  frontWalls,
  hitWall,
  inRange,
  localFrame,
  METRES_TO_INCHES,
  pitchFor,
  planShots,
  project,
  sizeBox,
  type Vec,
  type Vec3,
  wallsOf,
} from '../../src/estimator/windows-geometry.ts';

/*
 * Synthetic cameras and walls: a window of known size is put on a wall, projected into the photo with the pinhole
 * model, its bounding box taken (as a person or detector would draw it), and the box sized back. Within 5%.
 */

const cam = (o: Partial<Camera> = {}): Camera => ({ pos: [0, 0], heightM: CAMERA_HEIGHT_M, heading: 0, pitch: 0, fov: 60, widthPx: 640, heightPx: 640, ...o });

/** A rectangle on the wall from a to b: `along` metres from a, `widthM` wide, sill to head. Its photo bounding box. */
function boxOf(c: Camera, a: Vec, b: Vec, along: number, widthM: number, sillM: number, heightM: number) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const u: Vec = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const p0: Vec = [a[0] + u[0] * along, a[1] + u[1] * along];
  const p1: Vec = [p0[0] + u[0] * widthM, p0[1] + u[1] * widthM];
  const corners: Vec3[] = [
    [p0[0], p0[1], sillM],
    [p1[0], p1[1], sillM],
    [p0[0], p0[1], sillM + heightM],
    [p1[0], p1[1], sillM + heightM],
  ];
  const px = corners.map((q) => project(c, q)!);
  const xs = px.map((p) => p[0] / c.widthPx);
  const ys = px.map((p) => p[1] / c.heightPx);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** A 12 m by 8 m house whose front (south) wall is `dist` m north of the camera, turned by `turnDeg` round its middle. */
function house(dist: number, turnDeg = 0): Vec[] {
  const t = (turnDeg * Math.PI) / 180;
  const c: Vec = [0, dist + 4];
  const corners: Vec[] = [
    [-6, -4],
    [6, -4],
    [6, 4],
    [-6, 4],
  ];
  return corners.map(([x, y]) => [c[0] + x * Math.cos(t) - y * Math.sin(t), c[1] + x * Math.sin(t) + y * Math.cos(t)]);
}

const within = (got: number, want: number, share = 0.05) => expect(Math.abs(got - want) / want).toBeLessThan(share);

describe('walls', () => {
  it('outward normals for either winding, and jogs dropped', () => {
    const ccw = wallsOf(house(10));
    const cw = wallsOf([...house(10)].reverse());
    // The south wall (y = 10) faces south either way.
    for (const walls of [ccw, cw]) {
      const south = walls.find((w) => Math.abs(w.a[1] - 10) < 1e-9 && Math.abs(w.b[1] - 10) < 1e-9)!;
      expect(south.normal[1]).toBeCloseTo(-1, 9);
    }
    expect(wallsOf([[0, 0], [10, 0], [10, 0.2], [10, 5], [0, 5]])).toHaveLength(4);
  });

  it('the front is the wall facing the camera; an oblique house gives two front walls', () => {
    const front = frontWalls(wallsOf(house(15)), [0, 0]);
    expect(front).toHaveLength(1);
    expect(front[0]!.lengthM).toBeCloseTo(12, 6);
    expect(frontWalls(wallsOf(house(15, 45)), [0, 0])).toHaveLength(2);
  });

  it('a local frame round-trips and bearings are compass bearings', () => {
    const f = localFrame([-94.2, 36.37]);
    const p = f.toLngLat([30, -40]);
    const back = f.toLocal(p);
    expect(back[0]).toBeCloseTo(30, 6);
    expect(back[1]).toBeCloseTo(-40, 6);
    expect(bearing([0, 0], [0, 1])).toBeCloseTo(0);
    expect(bearing([0, 0], [1, 0])).toBeCloseTo(90);
    expect(bearing([0, 0], [-1, 0])).toBeCloseTo(270);
    expect(angleDiff(10, 350)).toBeCloseTo(20);
    expect(inRange(5, [350, 20])).toBe(true);
    expect(inRange(30, [350, 20])).toBe(false);
  });
});

describe('aiming', () => {
  it('one shot centred on a front that fits, fov with margin in 30..90', () => {
    const shots = planShots(frontWalls(wallsOf(house(20)), [0, 0]), [0, 0]);
    expect(shots).toHaveLength(1);
    expect(Math.abs(angleDiff(shots[0]!.heading, 0))).toBeLessThan(0.1);
    // The 12 m wall at 20 m spans about 33 degrees: with margin about 44.
    expect(shots[0]!.fov).toBeGreaterThan(38);
    expect(shots[0]!.fov).toBeLessThan(50);
    expect(shots[0]!.measure).toBe(true);
  });

  it('a near, wide front gets a whole shot (not counted on) and two halves (counted)', () => {
    const shots = planShots(frontWalls(wallsOf(house(5)), [0, 0]), [0, 0]);
    expect(shots.map((s) => s.role)).toEqual(['whole', 'part', 'part']);
    expect(shots[0]!.measure).toBe(false);
    expect(shots[0]!.fov).toBe(90);
    expect(angleDiff(shots[1]!.heading, 0)).toBeLessThan(0);
    expect(angleDiff(shots[2]!.heading, 0)).toBeGreaterThan(0);
  });

  it('a front off to the side: the heading points at it', () => {
    const shifted = house(20).map(([x, y]) => [x + 20, y] as Vec);
    const shots = planShots(frontWalls(wallsOf(shifted), [0, 0]), [0, 0]);
    expect(shots[0]!.heading).toBeGreaterThan(30);
    expect(shots[0]!.heading).toBeLessThan(60);
  });

  it('pitch keeps the ground and two storeys in view', () => {
    expect(pitchFor(20)).toBeGreaterThan(0);
    expect(pitchFor(20)).toBeLessThan(10);
    expect(pitchFor(3)).toBeLessThanOrEqual(20);
  });
});

describe('sizing a box', () => {
  const cases = [
    { name: 'square on, level', dist: 15, turn: 0, heading: 0, pitch: 0, fov: 60, along: 4, w: 0.91, sill: 0.9, h: 1.52 },
    { name: 'square on, pitched up', dist: 20, turn: 0, heading: 0, pitch: 6, fov: 50, along: 2, w: 1.22, sill: 0.8, h: 1.52 },
    { name: 'oblique wall (35 deg)', dist: 18, turn: 35, heading: 0, pitch: 3, fov: 70, along: 5, w: 0.91, sill: 0.9, h: 1.37 },
    { name: 'second floor', dist: 22, turn: 0, heading: 0, pitch: 8, fov: 50, along: 6, w: 0.76, sill: 3.8, h: 1.22 },
    { name: 'off-centre heading', dist: 16, turn: 10, heading: 12, pitch: 4, fov: 60, along: 8, w: 1.83, sill: 0.7, h: 1.52 },
  ];
  for (const k of cases) {
    it(`recovers a known window within 5%: ${k.name}`, () => {
      const c = cam({ heading: k.heading, pitch: k.pitch, fov: k.fov });
      const walls = wallsOf(house(k.dist, k.turn));
      const front = frontWalls(walls, c.pos);
      const wall = front.reduce((best, w) => (w.lengthM > best.lengthM ? w : best));
      const box = boxOf(c, wall.a, wall.b, k.along, k.w, k.sill, k.h);
      const sized = sizeBox(c, front, box)!;
      expect(sized).not.toBeNull();
      within(sized.widthIn, k.w * METRES_TO_INCHES);
      within(sized.heightIn, k.h * METRES_TO_INCHES);
      expect(Math.abs(sized.sillM - k.sill)).toBeLessThan(0.1);
      expect(sized.floor).toBe(k.sill < 2.4 ? 1 : 2);
    });
  }

  it('a box off the front (sky) is not sized', () => {
    const c = cam();
    const front = frontWalls(wallsOf(house(15)), c.pos);
    expect(sizeBox(c, front, { x: 0, y: 0, w: 0.05, h: 0.05 })).toBeNull();
  });

  it('a ray meets the nearest wall', () => {
    const c = cam();
    const hit = hitWall(c, wallsOf(house(15)), 320, 320)!;
    expect(hit.rangeM).toBeCloseTo(15, 6);
    expect(hit.point[2]).toBeCloseTo(CAMERA_HEIGHT_M, 6);
  });

  it('the facade region covers the front wall in the photo', () => {
    const c = cam({ fov: 60 });
    const r = facadeRegion(c, frontWalls(wallsOf(house(15)), c.pos), 6)!;
    expect(r.x).toBeGreaterThan(0.1);
    expect(r.x + r.w).toBeLessThan(0.9);
    expect(r.y + r.h).toBeGreaterThan(0.5);
  });

  it('floors by sill height', () => {
    expect(floorOf(0.9)).toBe(1);
    expect(floorOf(2.3)).toBe(1);
    expect(floorOf(3.8)).toBe(2);
    expect(floorOf(6.8)).toBe(3);
  });
});

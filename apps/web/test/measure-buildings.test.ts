import type { Ring } from '@roofline/shared';
import { describe, expect, it } from 'vitest';
import { liftMeasure, liftProposal } from '../src/copy/liftMeasure.ts';
import { buildingDetail, placePopover } from '../src/features/measure/lift/BuildingPopover.tsx';
import {
  BUILDING_LIST_RADIUS_M,
  buildingAt,
  describeBuildings,
  insideRing,
  mainIndex,
  metresBetweenRings,
  metresToRing,
  onlyIncluded,
} from '../src/features/measure/lift/structures.ts';

const LNG = -92.35;
const LAT = 34.75;
const M_PER_DEG = 111_320;
/** A spot `x` metres east and `y` metres north of the origin. */
const at = (x: number, y: number): [number, number] => [LNG + x / (M_PER_DEG * Math.cos((LAT * Math.PI) / 180)), LAT + y / M_PER_DEG];
const box = (x: number, y: number, w: number, h: number): Ring => [at(x, y), at(x + w, y), at(x + w, y + h), at(x, y + h)];

const HOUSE = { footprintId: 'home', ring: box(0, 0, 15, 12), areaSqFt: 1940, included: true };
const GARAGE = { footprintId: 'garage', ring: box(20, 2, 6, 7), areaSqFt: 450, included: false };
const NEXT_DOOR = { footprintId: 'next', ring: box(-22, 0, 14, 12), areaSqFt: 1810, included: false };
const BARN = { footprintId: 'barn', ring: box(0, 40, 20, 20), areaSqFt: 4300, included: false };
const FAR_SHED = { footprintId: 'far', ring: box(60, 0, 4, 4), areaSqFt: 170, included: false };

describe('distances on the photo', () => {
  it('measures point-to-ring and ring-to-ring gaps in metres (0 inside or touching)', () => {
    expect(metresToRing(at(5, 5), HOUSE.ring)).toBe(0);
    expect(metresToRing(at(25, 6), HOUSE.ring)).toBeCloseTo(10, 1);
    expect(metresBetweenRings(HOUSE.ring, GARAGE.ring)).toBeCloseTo(5, 1);
    expect(metresBetweenRings(HOUSE.ring, box(15, 0, 3, 3))).toBeCloseTo(0, 3);
    expect(insideRing(at(1, 1), HOUSE.ring)).toBe(true);
    expect(insideRing(at(-1, 1), HOUSE.ring)).toBe(false);
  });
});

describe('describeBuildings', () => {
  it('lists the main house first, then the others by distance from it, each with a role', () => {
    const rows = describeBuildings([NEXT_DOOR, HOUSE, GARAGE, BARN, FAR_SHED].map((s) => (s === HOUSE ? { ...s, main: true } : s)), at(7, 6));
    expect(rows.map((r) => [r.footprintId, r.role])).toEqual([
      ['home', 'main'],
      ['garage', 'detached'],
      ['next', 'neighbour'],
      ['barn', 'neighbour'],
      ['far', 'detached'],
    ]);
  });

  it('calls a house-sized building farther from the address point probably a neighbour\'s, and a small one detached', () => {
    const rows = describeBuildings([{ ...HOUSE, main: true }, GARAGE, NEXT_DOOR], at(7, 6));
    const byId = Object.fromEntries(rows.map((r) => [r.footprintId, r]));
    expect(byId.garage?.role).toBe('detached');
    expect(byId.next?.role).toBe('neighbour');
    // A big building nearer the address point than the main house is not called a neighbour's
    const nearer = describeBuildings([{ ...HOUSE, main: true }, NEXT_DOOR], at(-9, 6));
    expect(nearer[1]?.role).toBe('detached');
  });

  it('lists only buildings within the radius of the main house, and always the ones in the quote', () => {
    const rows = describeBuildings([{ ...HOUSE, main: true }, GARAGE, FAR_SHED, BARN], at(7, 6));
    const listed = Object.fromEntries(rows.map((r) => [r.footprintId, r.listed]));
    expect(listed).toEqual({ home: true, garage: true, barn: false, far: false });
    expect(rows.find((r) => r.footprintId === 'far')!.gapM).toBeGreaterThan(BUILDING_LIST_RADIUS_M);
    const kept = describeBuildings([{ ...HOUSE, main: true }, { ...FAR_SHED, included: true }], at(7, 6));
    expect(kept[1]?.listed).toBe(true);
  });

  it('takes the first building as the main one on an older measurement with no main mark', () => {
    expect(mainIndex([GARAGE, HOUSE])).toBe(0);
    expect(mainIndex([GARAGE, { ...HOUSE, main: true }])).toBe(1);
    expect(mainIndex([])).toBe(-1);
    expect(describeBuildings([], at(0, 0))).toEqual([]);
  });

  it('finds the building under a point, and the only one in the quote', () => {
    const rows = describeBuildings([{ ...HOUSE, main: true }, GARAGE], at(7, 6));
    expect(buildingAt(rows, at(22, 4))?.footprintId).toBe('garage');
    expect(buildingAt(rows, at(40, 40))).toBeNull();
    expect(onlyIncluded(rows)).toBe('home');
    expect(onlyIncluded(describeBuildings([{ ...HOUSE, main: true }, { ...GARAGE, included: true }], at(7, 6)))).toBeNull();
  });

  it('describes a building as a person reads it', () => {
    const [main, garage, next] = describeBuildings([{ ...HOUSE, main: true }, GARAGE, NEXT_DOOR], at(7, 6));
    expect(buildingDetail(main!)).toBe('1,940 sq ft');
    expect(buildingDetail(garage!)).toBe('450 sq ft · 16 ft away');
    expect(buildingDetail(next!)).toBe(`1,810 sq ft · 26 ft away · ${liftMeasure.probablyNeighbours}`);
    expect(liftMeasure.buildingAway(1)).toBe('touching the house');
  });
});

describe('the sections line on the proposal', () => {
  it('names the quoted sections', () => {
    expect(liftProposal.sectionsOnly(['C'], 7)).toBe('Section C only (1 of 7)');
    expect(liftProposal.sectionsOnly(['A', 'C'], 7)).toBe('Sections A and C only (2 of 7)');
    expect(liftProposal.sectionsOnly(['A', 'C', 'D'], 7)).toBe('Sections A, C and D only (3 of 7)');
  });
});

describe('placePopover', () => {
  const size = { w: 264, h: 200 };
  const box = { w: 800, h: 700 };
  const roof = { left: 300, right: 460, top: 280, bottom: 420 };
  const overlaps = (p: { left: number; top: number }) =>
    p.left < roof.right && p.left + size.w > roof.left && p.top < roof.bottom && p.top + size.h > roof.top;

  it('goes on the side of the click away from the roof, clear of it and inside the photo', () => {
    const above = placePopover({ x: 380, y: 230 }, size, box, roof);
    expect(overlaps(above)).toBe(false);
    expect(above.top + size.h).toBeLessThanOrEqual(roof.top);
    const right = placePopover({ x: 600, y: 350 }, size, box, roof);
    expect(right.left).toBeGreaterThanOrEqual(roof.right);
    expect(overlaps(right)).toBe(false);
    const left = placePopover({ x: 150, y: 350 }, size, box, roof);
    expect(left.left + size.w).toBeLessThanOrEqual(roof.left);
    for (const p of [above, right, left]) {
      expect(p.left).toBeGreaterThanOrEqual(8);
      expect(p.top).toBeGreaterThanOrEqual(8);
      expect(p.left + size.w).toBeLessThanOrEqual(box.w - 8);
      expect(p.top + size.h).toBeLessThanOrEqual(box.h - 8);
    }
  });

  it('goes below the click with no roof to keep clear of; with no clear side, where it covers the least roof', () => {
    expect(placePopover({ x: 400, y: 100 }, size, box, null)).toEqual({ left: 268, top: 112 });
    // A click just above the roof near the photo's top: no side is clear, the left one covers least
    const tight = placePopover({ x: 340, y: 85 }, size, box, { left: 295, right: 440, top: 175, bottom: 320 });
    expect(tight).toEqual({ left: 64, top: 8 });
  });
});

import { describe, it, expect } from 'vitest';
import { splitIntoRoutes, orderRoute, MAX_DOORS_PER_ROUTE } from '../src/door-routes.ts';
import type { Door } from '../src/door-types.ts';

// Seeded LCG so the fixtures are deterministic (no Math.random).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeDoors(n: number, fixtureSeed = 7): Door[] {
  const rand = lcg(fixtureSeed);
  const doors: Door[] = [];
  for (let i = 0; i < n; i++) {
    doors.push({
      key: 'd' + i,
      lat: 33.65 + (rand() - 0.5) * 0.2,
      lng: -117.84 + (rand() - 0.5) * 0.2,
      hailIn: Math.round(rand() * 200) / 100,
    });
  }
  return doors;
}

function allKeys(routes: { doors: Door[] }[]): string[] {
  return routes.flatMap((r) => r.doors.map((d) => d.key)).sort();
}

describe('splitIntoRoutes', () => {
  it('is deterministic for a seed; a different seed still yields a valid plan', () => {
    const doors = makeDoors(420);
    const a = splitIntoRoutes(doors, 2, 'storm-A');
    const b = splitIntoRoutes(doors, 2, 'storm-A');
    expect(b).toEqual(a);

    const c = splitIntoRoutes(doors, 2, 'storm-B');
    const expectedKeys = doors.map((d) => d.key).sort();
    expect(allKeys(c)).toEqual(expectedKeys);
    for (const r of c) {
      expect(r.doors.length).toBeLessThanOrEqual(MAX_DOORS_PER_ROUTE);
      expect(r.doors.length).toBeGreaterThan(0);
    }
  });

  it('visits every door exactly once', () => {
    const doors = makeDoors(777);
    const routes = splitIntoRoutes(doors, 3, 'seed-every');
    const keys = allKeys(routes);
    expect(keys).toEqual(doors.map((d) => d.key).sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps every route at or under 150 doors and never empty', () => {
    const doors = makeDoors(1000);
    const routes = splitIntoRoutes(doors, 2, 'seed-cap');
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      expect(r.doors.length).toBeGreaterThan(0);
      expect(r.doors.length).toBeLessThanOrEqual(MAX_DOORS_PER_ROUTE);
    }
  });

  it('reports a finite non-negative walk that 2-opt does not beat by re-ordering', () => {
    const doors = makeDoors(300);
    const routes = splitIntoRoutes(doors, 2, 'seed-walk');
    for (const r of routes) {
      expect(Number.isFinite(r.walkMeters)).toBe(true);
      expect(r.walkMeters).toBeGreaterThanOrEqual(0);
      expect(orderRoute(r.doors).walkMeters).toBeLessThanOrEqual(r.walkMeters + 1e-6);
    }
  });

  it('1 rep with 400 doors gives exactly 3 routes, all on rep 0', () => {
    const doors = makeDoors(400);
    const routes = splitIntoRoutes(doors, 1, 'one-rep');
    expect(routes).toHaveLength(3);
    for (const r of routes) expect(r.repIndex).toBe(0);
    expect(allKeys(routes)).toEqual(doors.map((d) => d.key).sort());
  });

  it('returns [] for empty input', () => {
    expect(splitIntoRoutes([], 3, 'empty')).toEqual([]);
  });

  it('plans 1,500 doors across 4 reps in well under a second', () => {
    const doors = makeDoors(1500);
    const start = performance.now();
    const routes = splitIntoRoutes(doors, 4, 'big-plan');
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(allKeys(routes)).toEqual(doors.map((d) => d.key).sort());
  });

  it('3 reps with 300 doors give rep indices 0..2 and balanced door counts', () => {
    const doors = makeDoors(300);
    const routes = splitIntoRoutes(doors, 3, 'three-reps');
    const perRep = new Map<number, number>();
    for (const r of routes) {
      expect(r.repIndex).toBeGreaterThanOrEqual(0);
      expect(r.repIndex).toBeLessThanOrEqual(2);
      perRep.set(r.repIndex, (perRep.get(r.repIndex) ?? 0) + r.doors.length);
    }
    const totals = [0, 1, 2].map((i) => perRep.get(i) ?? 0);
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(150);
    expect(totals.reduce((s, t) => s + t, 0)).toBe(300);
  });

  it('treats reps = 0 as 1', () => {
    const doors = makeDoors(260);
    const zero = splitIntoRoutes(doors, 0, 'zero-reps');
    const one = splitIntoRoutes(doors, 1, 'zero-reps');
    expect(zero).toEqual(one);
    for (const r of zero) expect(r.repIndex).toBe(0);
  });

  it('returns routes sorted by repIndex ascending', () => {
    const doors = makeDoors(500);
    const routes = splitIntoRoutes(doors, 3, 'sorted');
    for (let i = 1; i < routes.length; i++) {
      expect(routes[i]!.repIndex).toBeGreaterThanOrEqual(routes[i - 1]!.repIndex);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { orderRoute, nearestNeighbourOrder, routeLength } from '../src/door-tour.ts';
import type { Door } from '../src/door-types.ts';

// Seeded LCG so the fixtures are deterministic (no Math.random).
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeDoors(count: number, seed = 11): Door[] {
  const rng = makeRng(seed);
  const doors: Door[] = [];
  for (let i = 0; i < count; i++) {
    doors.push({
      key: `door-${String(i).padStart(4, '0')}`,
      lat: 33.65 + (rng() - 0.5) * 0.06,
      lng: -117.84 + (rng() - 0.5) * 0.06,
      hailIn: 1 + Math.floor(rng() * 20) / 10,
    });
  }
  return doors;
}

function shuffled<T>(items: T[], seed: number): T[] {
  const rng = makeRng(seed);
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

describe('orderRoute', () => {
  it('returns an empty route for empty input', () => {
    expect(orderRoute([])).toEqual({ doors: [], walkMeters: 0 });
  });

  it('returns a single door with zero walk', () => {
    const door: Door = { key: 'only', lat: 33.65, lng: -117.84, hailIn: 1.5 };
    const result = orderRoute([door]);
    expect(result.doors).toEqual([door]);
    expect(result.walkMeters).toBe(0);
  });

  it('visits every door exactly once', () => {
    const doors = makeDoors(60);
    const result = orderRoute(doors);
    expect(result.doors).toHaveLength(doors.length);
    const keys = result.doors.map((d) => d.key).sort();
    expect(keys).toEqual(doors.map((d) => d.key).sort());
    expect(new Set(keys).size).toBe(doors.length);
  });

  it('does not mutate the input array', () => {
    const doors = makeDoors(20);
    const before = doors.map((d) => d.key);
    orderRoute(doors);
    expect(doors.map((d) => d.key)).toEqual(before);
  });

  it('is deterministic for the same input', () => {
    const doors = makeDoors(60);
    expect(orderRoute(doors)).toEqual(orderRoute(doors));
  });

  it('gives the same route regardless of input order', () => {
    const doors = makeDoors(60);
    const base = orderRoute(doors);
    for (const seed of [1, 2, 3]) {
      expect(orderRoute(shuffled(doors, seed))).toEqual(base);
    }
  });

  it('starts at the door nearest the north-west corner', () => {
    // Corner = (max lat, min lng) = (33.70, -117.90).
    // The north door is the closest to that corner; the west and east doors are farther.
    const doors: Door[] = [
      { key: 'west', lat: 33.6, lng: -117.9, hailIn: 1 },
      { key: 'east', lat: 33.62, lng: -117.8, hailIn: 1 },
      { key: 'north', lat: 33.7, lng: -117.84, hailIn: 1 },
    ];
    const result = orderRoute(doors);
    expect(result.doors[0]!.key).toBe('north');
  });

  it('breaks start ties by key ascending', () => {
    // Two doors at identical distance from the corner (33.70, -117.90).
    const doors: Door[] = [
      { key: 'b', lat: 33.7, lng: -117.88, hailIn: 1 },
      { key: 'a', lat: 33.7, lng: -117.88, hailIn: 1 },
      { key: 'far', lat: 33.6, lng: -117.8, hailIn: 1 },
    ];
    expect(orderRoute(doors).doors[0]!.key).toBe('a');
  });

  it('never produces a longer path than nearest neighbour', () => {
    for (const seed of [21, 22, 23, 24, 25]) {
      const doors = makeDoors(60, seed);
      const nn = nearestNeighbourOrder(doors);
      const tour = orderRoute(doors);
      expect(tour.walkMeters).toBeLessThanOrEqual(nn.walkMeters + 1e-6);
    }
  });

  it('walkMeters equals the length of the returned path', () => {
    const doors = makeDoors(60, 31);
    const result = orderRoute(doors);
    expect(result.walkMeters).toBeCloseTo(routeLength(result.doors), 6);
  });

  it('orders doors on a straight line monotonically with the line length', () => {
    // Points march north-west along a straight line from the NW corner end.
    const doors: Door[] = [];
    for (let t = 0; t <= 10; t++) {
      doors.push({
        key: `line-${String(t).padStart(2, '0')}`,
        lat: 33.65 + t * 0.003,
        lng: -117.84 - t * 0.002,
        hailIn: 1,
      });
    }
    const result = orderRoute(shuffled(doors, 5));
    const order = result.doors.map((d) => Number(d.key.slice(5)));
    const ascending = order.every((v, i) => i === 0 || v > order[i - 1]!);
    const descending = order.every((v, i) => i === 0 || v < order[i - 1]!);
    expect(ascending || descending).toBe(true);

    const first = doors[10]!;
    const last = doors[0]!;
    const lineLength = routeLength([first, last]);
    expect(Math.abs(result.walkMeters - lineLength) / lineLength).toBeLessThan(1e-6);
  });
});

describe('nearestNeighbourOrder', () => {
  it('returns an empty route for empty input', () => {
    expect(nearestNeighbourOrder([])).toEqual({ doors: [], walkMeters: 0 });
  });

  it('visits every door exactly once', () => {
    const doors = makeDoors(60, 41);
    const nn = nearestNeighbourOrder(doors);
    expect(nn.doors.map((d) => d.key).sort()).toEqual(doors.map((d) => d.key).sort());
  });
});

import { describe, it, expect } from 'vitest';
import { pickDoors, clusterDoors } from '../src/door-kmeans.ts';
import type { Door } from '../src/door-types.ts';

// Seeded LCG so the fixtures are deterministic (no Math.random).
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeDoors(count: number, seed = 7): Door[] {
  const rng = makeRng(seed);
  const doors: Door[] = [];
  for (let i = 0; i < count; i++) {
    doors.push({
      key: `door-${String(i).padStart(4, '0')}`,
      lat: 33.65 + (rng() - 0.5) * 0.08,
      lng: -117.84 + (rng() - 0.5) * 0.08,
      hailIn: Math.round(rng() * 40) / 10,
    });
  }
  return doors;
}

function shuffled(doors: Door[], seed: number): Door[] {
  const rng = makeRng(seed);
  const out = doors.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('pickDoors', () => {
  it('orders largest hail first, then key, and respects max', () => {
    const doors: Door[] = [
      { key: 'c', lat: 33.6, lng: -117.8, hailIn: 1.0 },
      { key: 'a', lat: 33.6, lng: -117.8, hailIn: 2.0 },
      { key: 'b', lat: 33.6, lng: -117.8, hailIn: 2.0 },
      { key: 'd', lat: 33.6, lng: -117.8, hailIn: 0.5 },
    ];
    const picked = pickDoors(doors, 3);
    expect(picked.map((d) => d.key)).toEqual(['a', 'b', 'c']);
  });

  it('defaults to returning at most 1500 doors', () => {
    const doors = makeDoors(1600);
    expect(pickDoors(doors)).toHaveLength(1500);
  });

  it('does not mutate the input array', () => {
    const doors = makeDoors(30);
    const before = doors.map((d) => d.key);
    pickDoors(doors, 10);
    expect(doors.map((d) => d.key)).toEqual(before);
  });
});

describe('clusterDoors', () => {
  it('returns deep-equal output for the same doors, k and seed', () => {
    const doors = makeDoors(120);
    const a = clusterDoors(doors, 5, 'storm-42');
    const b = clusterDoors(doors, 5, 'storm-42');
    expect(b).toEqual(a);
  });

  it('gives the same output regardless of input order', () => {
    const doors = makeDoors(120);
    const a = clusterDoors(doors, 5, 'storm-42');
    const b = clusterDoors(shuffled(doors, 99), 5, 'storm-42');
    expect(b).toEqual(a);
  });

  it('places every door key exactly once', () => {
    const doors = makeDoors(120);
    const clusters = clusterDoors(doors, 6, 'seed-a');
    const keys = clusters.flat().map((d) => d.key).sort();
    expect(keys).toEqual(doors.map((d) => d.key).sort());
  });

  it('returns k non-empty clusters when n >= k', () => {
    const doors = makeDoors(60);
    const clusters = clusterDoors(doors, 4, 'seed-b');
    expect(clusters).toHaveLength(4);
    for (const cluster of clusters) {
      expect(cluster.length).toBeGreaterThan(0);
    }
  });

  it('keeps every cluster within ceil(n / k) doors', () => {
    const doors = makeDoors(101);
    const k = 4;
    const cap = Math.ceil(doors.length / k);
    const clusters = clusterDoors(doors, k, 'seed-c');
    for (const cluster of clusters) {
      expect(cluster.length).toBeLessThanOrEqual(cap);
    }
  });

  it('returns [] for empty input', () => {
    expect(clusterDoors([], 3, 'seed-d')).toEqual([]);
  });

  it('returns n singleton clusters when k is greater than n', () => {
    const doors = makeDoors(5);
    const clusters = clusterDoors(doors, 12, 'seed-e');
    expect(clusters).toHaveLength(5);
    for (const cluster of clusters) {
      expect(cluster).toHaveLength(1);
    }
    const keys = clusters.flat().map((d) => d.key).sort();
    expect(keys).toEqual(doors.map((d) => d.key).sort());
  });

  it('treats k <= 0 as a single cluster', () => {
    const doors = makeDoors(20);
    const clusters = clusterDoors(doors, 0, 'seed-f');
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(20);
  });
});

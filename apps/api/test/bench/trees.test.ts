import { describe, expect, test } from 'vitest';
import { MAX_OVER, type TreeCandidate, rankRegion, treeSlug } from '../../src/bench/roof3d/trees.ts';

function cand(id: string, hood: string, over: number, ring: number, lat = 34.75, lng = -92.3): TreeCandidate {
  return { id, region: 'r', metro: 'Little Rock', state: 'AR', neighbourhood: hood, lat, lng, areaM2: 150, over, ring, kind: over >= 0.25 ? 'over' : 'beside', score: 0.6 * Math.min(over, 0.6) / 0.6 + 0.4 * Math.min(ring, 0.7) / 0.7, footprint: [] };
}

describe('choosing tree houses', () => {
  const pool = [
    cand('osm-1', 'A', 0.5, 0.6, 34.75, -92.3),
    cand('osm-2', 'A', 0.45, 0.6, 34.751, -92.3),
    cand('osm-3', 'B', 0.4, 0.5, 34.752, -92.3),
    cand('osm-4', 'B', 0.05, 0.6, 34.753, -92.3),
    cand('osm-5', 'C', 0.02, 0.2, 34.754, -92.3),
    cand('osm-6', 'C', MAX_OVER + 0.05, 0.9, 34.755, -92.3),
    cand('osm-7', 'A', 0.12, 0.7, 34.756, -92.3),
  ];

  test('drops the hidden, the bare and the duplicates of houses already in the set', () => {
    const order = rankRegion(pool, [{ lat: 34.75, lng: -92.3 }]).map((c) => c.id);
    expect(order).not.toContain('osm-6');
    expect(order).not.toContain('osm-5');
    expect(order).not.toContain('osm-1');
    expect(order).toContain('osm-4');
  });

  test('takes turns between neighbourhoods, mixes over and beside, and is the same every time', () => {
    const order = rankRegion(pool).map((c) => c.id);
    expect(order).toEqual(['osm-1', 'osm-7', 'osm-3', 'osm-4', 'osm-2']);
    expect(rankRegion(pool).map((c) => c.id)).toEqual(order);
    expect(rankRegion([...pool].reverse()).map((c) => c.id)).toEqual(order);
    const kinds = rankRegion(pool).map((c) => c.kind);
    expect(kinds.indexOf('beside')).toBeGreaterThan(0);
  });

  test('a house is only listed once', () => {
    const order = rankRegion([...pool, ...pool]).map((c) => c.id);
    expect(new Set(order).size).toBe(order.length);
  });

  test('folder names are stable and tidy', () => {
    expect(treeSlug({ metro: 'North Little Rock', id: 'osm-639701245' })).toBe('tr-north-little-rock-639701245');
  });
});

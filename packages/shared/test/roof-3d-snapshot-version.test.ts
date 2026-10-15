import { describe, expect, it } from 'vitest';
import {
  ROOF_3D_ALGORITHM_VERSION,
  ROOF_3D_SNAPSHOT_SCHEMA,
  type Roof3d,
  type Roof3dSnapshot,
  roof3dSnapshotFresh,
  roof3dSnapshotStamp,
  roof3dSnapshotVersion,
} from '../src/roof-3d.ts';
import { reconstructRoof, toRoof3d } from '../src/roof-reconstruct/index.ts';
import { HIP, synthesize } from './fixtures/synthetic-roofs.ts';

/*
 * FM01 (stale, unversioned 3D snapshot cache): a snapshot kept by an older reconstruction must never be served as
 * fresh, so an improved algorithm shows on homes measured before it. Old rows must still read.
 */

const LNG0 = -96.0;
const LAT0 = 41.25;
const K = (Math.PI / 180) * 6371008.8;
const COS = Math.cos((LAT0 * Math.PI) / 180);
const toLngLat = (x: number, y: number): [number, number] => [LNG0 + x / (K * COS), LAT0 + y / K];
const syn = synthesize(HIP, { turnDeg: 17 });
const ROOF: Roof3d = toRoof3d(reconstructRoof(syn.raster, syn.point)!, toLngLat, { imageryQuality: 'HIGH', imageryDate: '2024-05-01' });
const NOW = new Date('2026-10-12T12:00:00Z');
const AT = ROOF.faces[0]!.labelAt;

/** A snapshot as commits before the version existed stored it: no schemaVersion, no algorithmVersion. */
const LEGACY: Roof3dSnapshot = { fetchedAt: '2026-10-11T18:07:00Z', at: AT, roof: ROOF };

describe('3D snapshot versions', () => {
  it('a snapshot stored before versions existed reads as schema 1, algorithm 1', () => {
    expect(roof3dSnapshotVersion(LEGACY)).toEqual({ schema: 1, algorithm: 1 });
  });

  it('a legacy snapshot (the 305 Ridgeway Dr case) is never fresh, however recent', () => {
    expect(roof3dSnapshotFresh(LEGACY, AT, NOW)).toBe(false);
  });

  it('a snapshot stamped by this commit is fresh', () => {
    const kept = roof3dSnapshotStamp({ fetchedAt: '2026-10-11T18:07:00Z', at: AT, roof: ROOF });
    expect(kept.schemaVersion).toBe(ROOF_3D_SNAPSHOT_SCHEMA);
    expect(kept.algorithmVersion).toBe(ROOF_3D_ALGORITHM_VERSION);
    expect(roof3dSnapshotFresh(kept, AT, NOW)).toBe(true);
  });

  it('an older or newer algorithm version is stale (a rollback never serves a newer reconstruction either)', () => {
    const kept = roof3dSnapshotStamp({ fetchedAt: '2026-10-11T18:07:00Z', at: AT, roof: ROOF });
    expect(roof3dSnapshotFresh({ ...kept, algorithmVersion: ROOF_3D_ALGORITHM_VERSION - 1 }, AT, NOW)).toBe(false);
    expect(roof3dSnapshotFresh({ ...kept, algorithmVersion: ROOF_3D_ALGORITHM_VERSION + 1 }, AT, NOW)).toBe(false);
  });

  it('garbage versions are stale, never a throw', () => {
    const kept = roof3dSnapshotStamp({ fetchedAt: '2026-10-11T18:07:00Z', at: AT, roof: ROOF });
    for (const bad of ['2', 2.5, Number.NaN, -1, null, {}, Number.POSITIVE_INFINITY]) {
      const s = { ...kept, algorithmVersion: bad } as unknown as Roof3dSnapshot;
      expect(() => roof3dSnapshotFresh(s, AT, NOW)).not.toThrow();
      expect(roof3dSnapshotFresh(s, AT, NOW)).toBe(false);
    }
  });

  it('a kept "no imagery" answer is about Google, not the algorithm: it stays fresh across versions', () => {
    const none: Roof3dSnapshot = { fetchedAt: '2026-10-11T18:07:00Z', at: AT, roof: null, none: 'no-imagery' };
    expect(roof3dSnapshotFresh(none, AT, NOW)).toBe(true);
  });

  it('a kept "no roof" from an older algorithm is stale (the algorithm may now find the roof)', () => {
    const none: Roof3dSnapshot = { fetchedAt: '2026-10-11T18:07:00Z', at: AT, roof: null, none: 'no-roof' };
    expect(roof3dSnapshotFresh(none, AT, NOW)).toBe(false);
    expect(roof3dSnapshotFresh(roof3dSnapshotStamp(none), AT, NOW)).toBe(true);
  });

  it('unknown extra fields from a newer schema do not break reading', () => {
    const kept = { ...roof3dSnapshotStamp({ fetchedAt: '2026-10-11T18:07:00Z', at: AT, roof: ROOF }), futureField: { x: 1 } } as Roof3dSnapshot;
    expect(roof3dSnapshotFresh(kept, AT, NOW)).toBe(true);
    expect(roof3dSnapshotVersion(kept)).toEqual({ schema: ROOF_3D_SNAPSHOT_SCHEMA, algorithm: ROOF_3D_ALGORITHM_VERSION });
  });
});

import { describe, expect, it } from 'vitest';
import { roof3dSnapshotStamp, type Roof3d, type Roof3dSnapshot } from '@roofline/shared';
import { roof3dStatus } from '@roofline/db';

/*
 * What a stored measurement tells the screen about its 3D roof: why there is none (typed), and whether the roof shown
 * is an older reconstruction's. Old rows and unknown values read without a throw and claim nothing.
 */

const ROOF = { version: 1, outline: [], faces: [], lines: [], pixelSizeM: 0.1, imageryQuality: 'HIGH', imageryDate: null } as unknown as Roof3d;
const at: [number, number] = [-92.3, 34.75];

describe('roof3dStatus', () => {
  it('a typed reason when there is no roof, nothing for an unknown one', () => {
    expect(roof3dStatus(roof3dSnapshotStamp({ fetchedAt: '2026-10-01', at, roof: null, none: 'clipped' }), false)).toEqual({ roof3dMissing: 'clipped' });
    expect(roof3dStatus({ fetchedAt: '2026-10-01', at, roof: null, none: 'no-roof' }, false)).toEqual({ roof3dMissing: 'no-roof' });
    expect(roof3dStatus({ fetchedAt: '2026-10-01', at, roof: null, none: 'martian' } as unknown as Roof3dSnapshot, false)).toEqual({ roof3dMissing: null });
    expect(roof3dStatus(null, false)).toEqual({ roof3dMissing: null });
  });

  it('a roof from an older reconstruction (no version: the 305 Ridgeway Dr rows) is marked outdated; a current one is not', () => {
    expect(roof3dStatus({ fetchedAt: '2026-10-01', at, roof: ROOF }, true)).toEqual({ roof3dMissing: null, roof3dOutdated: true });
    expect(roof3dStatus(roof3dSnapshotStamp({ fetchedAt: '2026-10-01', at, roof: ROOF }), true)).toEqual({ roof3dMissing: null });
  });
});

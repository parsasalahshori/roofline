import { describe, expect, it } from 'vitest';
import { allowedLidarUrl, chooseUnit, leafOffSpan, unitsFromIndex } from '../../src/providers/usgs-lidar.ts';
import { TILE_URL, unit } from './usgs-lidar-fixture.ts';

/* The 3DEP index answers (WESM work units, TNM tiles) into units, and which unit a house reads. */

const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const WESM = {
  features: [
    { attributes: { workunit: 'AR_Western_4_B24', project: 'AR_Western_B24', ql: 'QL 1', collect_start: ms('2025-01-02'), collect_end: ms('2025-03-26') } },
    { attributes: { workunit: 'AR_R6_Pulaski_2012', project: 'FEMA_R6', ql: 'QL 2', collect_start: ms('2012-06-01'), collect_end: ms('2012-07-20') } },
    { attributes: { workunit: '../evil', project: 'x', ql: 'QL 1', collect_start: ms('2020-01-01'), collect_end: ms('2020-01-02') } },
  ],
};
const TNM = {
  items: [
    { downloadURL: TILE_URL, sizeInBytes: 64_000_000 },
    { downloadURL: 'https://rockyweb.usgs.gov/x/AR_R6_Pulaski_2012/LAZ/a.laz', sizeInBytes: 50_000_000 },
    { downloadURL: 'https://evil.example.com/AR_Western_4_B24/LAZ/b.laz' },
  ],
};

describe('3DEP index', () => {
  it('leaf-off is every flight day in November..April', () => {
    expect(leafOffSpan('2025-01-02', '2025-03-26')).toBe(true);
    expect(leafOffSpan('2024-11-20', '2025-02-01')).toBe(true);
    expect(leafOffSpan('2025-03-01', '2025-05-02')).toBe(false);
    expect(leafOffSpan('2012-06-01', '2012-07-20')).toBe(false);
    expect(leafOffSpan('2019-01-01', '2020-01-30')).toBe(false);
    expect(leafOffSpan(null, '2025-01-01')).toBeNull();
  });

  it('turns WESM features and TNM items into units with their own tiles, refusing other hosts and odd names', () => {
    const units = unitsFromIndex(WESM, TNM);
    expect(units.map((u) => u.workunit)).toEqual(['AR_R6_Pulaski_2012', 'AR_Western_4_B24']);
    const w = units.find((u) => u.workunit === 'AR_Western_4_B24')!;
    expect(w).toMatchObject({ ql: 1, collectStart: '2025-01-02', collectEnd: '2025-03-26', leafOff: true, tiles: [{ url: TILE_URL, bytes: 64_000_000 }] });
    expect(() => unitsFromIndex({ error: 'x' }, TNM)).toThrow(expect.objectContaining({ reason: 'bad-answer' }));
  });

  it('chooses leaf-off before leaf-on, then the newest; leaf-on only and no coverage are typed', () => {
    const units = unitsFromIndex(WESM, TNM);
    expect(chooseUnit(units)).toEqual({ unit: units.find((u) => u.workunit === 'AR_Western_4_B24') });
    expect(chooseUnit(units.filter((u) => u.workunit !== 'AR_Western_4_B24'))).toEqual({ none: 'leaf-on-only' });
    expect(chooseUnit([])).toEqual({ none: 'no-coverage' });
    expect(chooseUnit([unit({ ql: 3 })])).toEqual({ none: 'no-coverage' });
    expect(chooseUnit([unit({ tiles: [] })])).toEqual({ none: 'no-coverage' });
    const older = unit({ workunit: 'A_2018', collectEnd: '2018-02-01' });
    const newer = unit({ workunit: 'B_2025', collectEnd: '2025-02-01' });
    expect(chooseUnit([older, newer])).toEqual({ unit: newer });
    expect(chooseUnit([newer, older])).toEqual({ unit: newer });
  });

  it('only https USGS / AWS open-data hosts, never with credentials', () => {
    expect(allowedLidarUrl(TILE_URL)).toBe(true);
    expect(allowedLidarUrl('https://s3-us-west-2.amazonaws.com/usgs-lidar-public/X/ept.json')).toBe(true);
    expect(allowedLidarUrl(TILE_URL.replace('https:', 'http:'))).toBe(false);
    expect(allowedLidarUrl('https://evil.example.com/a.laz')).toBe(false);
    expect(allowedLidarUrl('https://u:p@rockyweb.usgs.gov/a.laz')).toBe(false);
    expect(allowedLidarUrl('not a url')).toBe(false);
  });
});

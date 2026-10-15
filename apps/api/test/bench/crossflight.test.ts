import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { crossFlightHash, fusedFlightOf, selectCrossFlightTruth, type CrossFlightPick } from '../../src/bench/roof3d/crossflight.ts';

/*
 * Cross-flight truth selection (crossflight.ts): a run that fused flight F is scored on truth from another flight,
 * or not at all. Hermetic: a temporary bench folder with hand-made files.
 */

const RING: [number, number][] = [
  [-92.311, 34.7532],
  [-92.3109, 34.7532],
  [-92.3109, 34.7533],
  [-92.311, 34.7533],
  [-92.311, 34.7532],
];

function truth(unit: string, project: string) {
  return {
    slug: 'h',
    ok: true,
    version: 1,
    source: { project, workunit: unit, ql: 'QL 1', pointDates: ['2025-01-02'], credit: 'USGS 3DEP' },
    frame: { dxM: 0, dyM: 0, dzM: 0, madM: 0.05 },
    method: { expectedEdgeErrorM: 0.25, spacingM: 0.25, cellM: 0.25 },
    outline: [{ outer: RING, holes: [] }],
    planAreaM2: 100,
    slopedAreaM2: 110,
    mainPitchX12: 6,
    planes: [],
    checks: {},
  };
}

type Reg = Record<string, Record<string, unknown>>;

function bench(registry: Reg, units: { unit: string; project: string }[] = [
  { unit: 'OLD', project: 'P2016' },
  { unit: 'NEW', project: 'P2025' },
]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'xf-bench-'));
  for (const u of units) {
    mkdirSync(path.join(dir, 'lidar', 'h', 'units', u.unit), { recursive: true });
    writeFileSync(path.join(dir, 'lidar', 'h', 'units', u.unit, 'truth.json'), JSON.stringify(truth(u.unit, u.project)));
  }
  writeFileSync(path.join(dir, 'lidar', 'h', 'crossflight.json'), JSON.stringify({ version: 1, slug: 'h', units, registry }));
  return dir;
}

const fine = (truthUnit: string, truthProject: string) => ({ truthUnit, truthProject, tier: 'fine', expectedEdgeErrorM: 0.25, interFlightIoU: 0.9 });

describe('cross-flight truth selection', () => {
  test('fusing the old flight scores on the new flight', () => {
    const b = bench({ OLD: fine('NEW', 'P2025'), NEW: { truthUnit: null, refused: ['outlines-disagree'] } });
    const p = selectCrossFlightTruth(b, 'h', 'OLD', { allowCoarse: false });
    expect(p.truth?.source.workunit).toBe('NEW');
    expect(p.truth === null ? null : p.tier).toBe('fine');
  });

  test('a refused flight gives no truth and says why (never the primary truth)', () => {
    const b = bench({ OLD: fine('NEW', 'P2025'), NEW: { truthUnit: null, refused: ['outlines-disagree'] } });
    const p = selectCrossFlightTruth(b, 'h', 'NEW', { allowCoarse: false });
    expect(p.truth).toBeNull();
    expect(p.truth === null && p.reason).toBe('refused:outlines-disagree');
  });

  test('coarse truth only when asked', () => {
    const b = bench({ NEW: { ...fine('OLD', 'P2016'), tier: 'coarse', expectedEdgeErrorM: 0.48 } });
    expect(selectCrossFlightTruth(b, 'h', 'NEW', { allowCoarse: false })).toMatchObject({ truth: null, reason: 'coarse-truth' });
    expect(selectCrossFlightTruth(b, 'h', 'NEW', { allowCoarse: true }).truth?.source.workunit).toBe('OLD');
  });

  test('no crop, no record, an unknown flight: no truth, with a reason each', () => {
    const b = bench({ OLD: fine('NEW', 'P2025') });
    expect(selectCrossFlightTruth(b, 'h', null, { allowCoarse: true })).toMatchObject({ truth: null, reason: 'no-fused-flight' });
    expect(selectCrossFlightTruth(b, 'other', 'OLD', { allowCoarse: true })).toMatchObject({ truth: null, reason: 'no-crossflight-record' });
    expect(selectCrossFlightTruth(b, 'h', 'MID', { allowCoarse: true })).toMatchObject({ truth: null, reason: 'fused-flight-not-registered' });
  });

  test('GUARD: a registry that hands back the fused flight itself is refused loudly', () => {
    // the fused flight's project unknown (null), so only the work-unit check can catch it
    const b = bench({ OLD: fine('OLD', 'P2016') });
    writeFileSync(
      path.join(b, 'lidar', 'h', 'crossflight.json'),
      JSON.stringify({ version: 1, slug: 'h', units: [{ unit: 'OLD', project: null }], registry: { OLD: fine('OLD', 'P2016') } }),
    );
    writeFileSync(path.join(b, 'lidar', 'h', 'units', 'OLD', 'truth.json'), JSON.stringify(truth('OLD-relabelled', 'P2016')));
    expect(() => selectCrossFlightTruth(b, 'h', 'OLD', { allowCoarse: true })).toThrow(/circular/);
  });

  test('GUARD: another work unit of the SAME project is the same flight', () => {
    const b = bench({ A: fine('B', 'P2025') }, [
      { unit: 'A', project: 'P2025' },
      { unit: 'B', project: 'P2025' },
    ]);
    expect(() => selectCrossFlightTruth(b, 'h', 'A', { allowCoarse: true })).toThrow(/circular/);
  });

  test('GUARD: the truth file itself must not name the fused flight (a mislabelled folder)', () => {
    const b = bench({ OLD: fine('NEW', 'P2025') });
    // the file's project differs from the fused one: only the file's own work-unit label gives it away
    writeFileSync(path.join(b, 'lidar', 'h', 'units', 'NEW', 'truth.json'), JSON.stringify(truth('OLD', 'P-other')));
    expect(() => selectCrossFlightTruth(b, 'h', 'OLD', { allowCoarse: true })).toThrow(/circular/);
  });

  test('the fused flight is read from the crop the method read', () => {
    const b = bench({});
    mkdirSync(path.join(b, 'lidar-edges-xf'));
    writeFileSync(
      path.join(b, 'lidar-edges-xf', 'h.json'),
      JSON.stringify({ slug: 'h', workunit: 'OLD', project: 'P2016', utmEpsg: 32615, originE: 0, originN: 0, count: 0, leafOff: true, flightEnd: '2017-03-01', fetchKind: 'ept', fetchBytes: 1, cropBytes: 0 }),
    );
    expect(fusedFlightOf(b, 'lidar-edges-xf', 'h')).toBe('OLD');
    expect(fusedFlightOf(b, 'lidar-edges-xf', 'nope')).toBeNull();
  });

  test('the fingerprint is order-independent, and differs with the truth set and with coarse', () => {
    const b = bench({ OLD: fine('NEW', 'P2025') });
    const p = selectCrossFlightTruth(b, 'h', 'OLD', { allowCoarse: false });
    const none: CrossFlightPick = { truth: null, reason: 'no-fused-flight', fusedUnit: null };
    const m1 = new Map<string, CrossFlightPick>([
      ['h', p],
      ['g', none],
    ]);
    const m2 = new Map<string, CrossFlightPick>([
      ['g', none],
      ['h', p],
    ]);
    expect(crossFlightHash(m1, false)).toBe(crossFlightHash(m2, false));
    expect(crossFlightHash(m1, false)).toMatch(/^xf:/);
    expect(crossFlightHash(m1, true)).not.toBe(crossFlightHash(m1, false));
    expect(crossFlightHash(new Map([['h', none]]), false)).not.toBe(crossFlightHash(m1, false));
  });
});

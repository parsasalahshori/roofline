import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { DEFAULT_GATES } from '../../src/bench/roof3d/gates.ts';
import { type Manifest } from '../../src/bench/roof3d/manifest.ts';
import { DEFAULT_THRESHOLDS } from '../../src/bench/roof3d/tags.ts';
import { house } from './helpers.ts';

/*
 * The command line itself, in a folder of its own (ROOF_BENCH_DIR) holding a manifest and no data: the exit codes and
 * the refusals that do not need a house to be read.
 */

const API = path.resolve(import.meta.dirname, '../..');
const run = (args: string[], dir: string) =>
  spawnSync('npx', ['tsx', 'src/scripts/roof-3d-bench.ts', ...args], { cwd: API, env: { ...process.env, ROOF_BENCH_DIR: dir }, encoding: 'utf8', timeout: 90_000 });

function folder(houses = [house('lr-305-ridgeway'), house('a')]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'roof-bench-'));
  const m: Manifest = { version: 1, generatedAt: 'x', splitRule: 'r', thresholds: DEFAULT_THRESHOLDS, houses };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  return dir;
}

describe('the roof3d:bench command', () => {
  test('a bad --split is a usage error (2)', () => {
    const r = run(['--split', 'nonsense'], folder());
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--split must be/);
  });

  test('no manifest is a data problem (3) that says how to make one', () => {
    const r = run([], mkdtempSync(path.join(tmpdir(), 'roof-bench-empty-')));
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/roof3d:bench-manifest/);
  });

  test('--counts lists the cohorts without running anything', () => {
    const r = run(['--counts'], folder());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/cohort +dev +heldout +total/);
    expect(r.stdout).toMatch(/all +1 +1 +2/);
    expect(r.stdout).toMatch(/canopy-heavy/);
  });

  test('--init-gates writes the contract once and never overwrites it', () => {
    const dir = folder();
    expect(run(['--init-gates'], dir).stdout).toMatch(/wrote/);
    const again = run(['--init-gates'], dir);
    expect(again.stdout).toMatch(/already exists/);
    const gates = JSON.parse(readFileSync(path.join(dir, 'gates.json'), 'utf8'));
    expect(gates).toEqual(DEFAULT_GATES);
  });

  test('Google data past its date stops the run (3) unless told otherwise', () => {
    const stale = house('lr-305-ridgeway', { data: { downloadedAt: '2020-01-01', deleteBy: '2020-01-31', imageryQuality: 'HIGH', imageryDate: null } });
    const r = run(['--split', 'dev'], folder([stale]));
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/past its 30-day date/);
  });

  test('a manifest whose split was changed by hand is refused (3)', () => {
    const r = run([], folder([house('lr-305-ridgeway', { split: 'heldout' })]));
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/frozen rule/);
  });
});

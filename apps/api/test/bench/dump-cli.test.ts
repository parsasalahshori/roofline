import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseExtraManifest, parseManifest } from '../../src/bench/roof3d/manifest.ts';
import { DEFAULT_THRESHOLDS } from '../../src/bench/roof3d/tags.ts';
import { heightTiff, maskTiff, rgbTiff } from '../pure/tiffs.ts';
import { house } from './helpers.ts';

/*
 * roof3d:dump --manifest FILE: a set of houses kept beside the frozen manifest.json (a sealed fresh set of answer keys)
 * is dumped from its own list, in its own set folder and with its own split name, and never touches manifest.json.
 */

const API = path.resolve(import.meta.dirname, '../..');
const run = (args: string[], dir: string) =>
  spawnSync('npx', ['tsx', 'src/scripts/roof-3d-dump.ts', ...args], { cwd: API, env: { ...process.env, ROOF_BENCH_DIR: dir }, encoding: 'utf8', timeout: 90_000 });

/** A fresh-set house: the helpers' house in a set folder and a split the frozen manifest does not know. */
const fresh = (slug: string) => ({ ...house(slug), set: 'testset-ev2', dir: `testset-ev2/${slug}`, split: 'fresh', point: [-92.3115043, 34.7531525] as [number, number] });
const manifestOf = (houses: unknown[]) => ({ version: 1, generatedAt: 'x', splitRule: 'none: a sealed set', thresholds: DEFAULT_THRESHOLDS, houses });

/** A bench folder holding only the extra manifest and one house: a 12 m by 9 m gable (6/12) on flat ground, 0.1 m pixels. */
function folder(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'roof-dump-'));
  writeFileSync(path.join(dir, 'manifest-ev2.json'), JSON.stringify(manifestOf([fresh('ev2-gable')])));
  const h = path.join(dir, 'testset-ev2', 'ev2-gable');
  mkdirSync(h, { recursive: true });
  const g = { width: 300, height: 300 };
  const roof = (i: number) => {
    const x = (i % g.width) * 0.1;
    const y = Math.floor(i / g.width) * 0.1;
    return x >= 9 && x < 21 && y >= 10.5 && y < 19.5 ? { rise: 0.5 * (4.5 - Math.abs(y - 15)) } : null;
  };
  writeFileSync(path.join(h, 'dsm.tif'), Buffer.from(heightTiff(g, (i) => 100 + (roof(i) === null ? 0 : 3 + roof(i)!.rise))));
  writeFileSync(path.join(h, 'mask.tif'), Buffer.from(maskTiff(g, (i) => (roof(i) === null ? 0 : 1))));
  writeFileSync(path.join(h, 'rgb.tif'), Buffer.from(rgbTiff(g)));
  writeFileSync(path.join(h, 'meta.json'), JSON.stringify({ imageryQuality: 'HIGH' }));
  return dir;
}

describe('a manifest beside the frozen one', () => {
  test('takes a free set folder and split name, which the frozen manifest refuses', () => {
    const m = manifestOf([fresh('ev2-a')]);
    expect(parseExtraManifest(m).houses[0]).toMatchObject({ set: 'testset-ev2', split: 'fresh' });
    expect(() => parseManifest(m)).toThrow();
  });

  test('refuses a duplicate house and a folder that is not <set>/<slug>', () => {
    expect(() => parseExtraManifest(manifestOf([fresh('ev2-a'), fresh('ev2-a')]))).toThrow(/duplicate house ev2-a/);
    expect(() => parseExtraManifest(manifestOf([{ ...fresh('ev2-a'), dir: 'testset-ev/ev2-a' }]))).toThrow(/dir testset-ev\/ev2-a is not testset-ev2\/ev2-a/);
  });
});

describe('the roof3d:dump command', () => {
  test('--manifest FILE dumps the houses of that list from their own set folder', () => {
    const dir = folder();
    const out = path.join(dir, 'out');
    const r = run(['--out', out, '--manifest', 'manifest-ev2.json'], dir);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/1 houses written/);
    const roof = JSON.parse(readFileSync(path.join(out, 'ev2-gable.json'), 'utf8')) as { faces: unknown[]; lines: { kind: string }[] } | null;
    expect(roof).not.toBeNull();
    expect(roof!.faces.length).toBeGreaterThanOrEqual(2);
    expect(roof!.lines.some((l) => l.kind === 'ridge')).toBe(true);
    // the frozen manifest was neither needed nor written
    expect(existsSync(path.join(dir, 'manifest.json'))).toBe(false);
  });

  test('--set and --house still narrow the list, and an absolute path works', () => {
    const dir = folder();
    const out = path.join(dir, 'out');
    const none = run(['--out', out, '--manifest', path.join(dir, 'manifest-ev2.json'), '--set', 'testset-ev'], dir);
    expect(none.stdout).toMatch(/0 houses written/);
    const one = run(['--out', out, '--manifest', path.join(dir, 'manifest-ev2.json'), '--house', 'ev2-gable'], dir);
    expect(one.stdout).toMatch(/1 houses written/);
  });

  test('--manifest without a file is a usage error (2)', () => {
    const r = run(['--manifest', '--out', path.join(tmpdir(), 'x')], folder());
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--manifest takes a file/);
  });
});

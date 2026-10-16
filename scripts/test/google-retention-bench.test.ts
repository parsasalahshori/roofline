import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { derivedImages, due, googleFolders, main, manifestDates, parseArgs, scratchpads } from '../google-retention-bench.ts';

let root: string;
const put = (rel: string, body = 'x') => {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, body);
  return full;
};
const age = (full: string, iso: string) => utimesSync(full, new Date(iso), new Date(iso));

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'google-retention-bench-'));
});
afterEach(() => undefined);

describe('google-retention-bench', () => {
  test('due on the delete-by date, earlier with fewer days kept', () => {
    expect(due('2026-11-10', '2026-11-09')).toBe(false);
    expect(due('2026-11-10', '2026-11-10')).toBe(true);
    expect(due('2026-11-10', '2026-11-03', 23)).toBe(true);
    expect(due('2026-11-10', '2026-11-02', 23)).toBe(false);
    expect(due('garbled', '2026-01-01')).toBe(true);
  });

  test('house folders: only the Google files, dated by the manifest, else info.json, else the files', () => {
    put('testset/a/dsm.tif');
    put('testset/a/rgb.tif');
    put('testset/a/meta.json');
    put('testset/a/truth.json');
    put('testset/a/eagleview.json');
    put('testset/b/bi.json');
    put('testset/b/info.json', JSON.stringify({ downloadedAt: '2026-09-01T00:00:00Z' }));
    age(put('testset/c/mask.tif'), '2026-08-01T00:00:00Z');
    put('analysis/meta.json'); // not beside a Solar file: not Google's
    put('manifest.json', JSON.stringify({ houses: [{ dir: 'testset/a', data: { deleteBy: '2026-11-10' } }] }));
    const found = googleFolders([root], manifestDates(root));
    const by = Object.fromEntries(found.map((f) => [path.basename(f.dir), f]));
    expect(by.a).toMatchObject({ kind: 'solar', files: ['dsm.tif', 'rgb.tif', 'meta.json'], deleteBy: '2026-11-10', source: 'manifest' });
    expect(by.b).toMatchObject({ files: ['bi.json'], deleteBy: '2026-10-01', source: 'info' });
    expect(by.c).toMatchObject({ files: ['mask.tif'], deleteBy: '2026-08-31', source: 'mtime' });
    expect(by.analysis).toBeUndefined();
  });

  test('Street View photos in a scratchpad sv folder, each dated by its own time', () => {
    age(put('pad/sv/old.jpg'), '2026-08-01T00:00:00Z');
    age(put('pad/sv/new.jpg'), '2026-10-15T00:00:00Z');
    put('pad/sv/notes.txt');
    const found = googleFolders([path.join(root, 'pad')], new Map());
    expect(found.map((f) => [f.kind, f.files, f.deleteBy])).toEqual([
      ['street-view', ['old.jpg'], '2026-08-31'],
      ['street-view', ['new.jpg'], '2026-11-14'],
    ]);
  });

  test('derived images outside the house folders are listed with the earliest house date', () => {
    put('testset/a/dsm.tif');
    put('verify/overlays/a.png');
    put('track/svg/a.svg', '<svg><image href="data:image/png;base64,AAAA"/></svg>');
    put('track/svg/plain.svg', '<svg><path d="M0 0"/></svg>');
    put('manifest.json', JSON.stringify({ houses: [{ dir: 'testset/a', data: { deleteBy: '2026-11-10' } }] }));
    const houses = googleFolders([root], manifestDates(root));
    const derived = derivedImages([root], houses);
    expect(derived.map((d) => [path.relative(root, d.dir), d.files, d.deleteBy])).toEqual([
      ['track/svg', ['a.svg'], '2026-11-10'],
      ['verify/overlays', ['a.png'], '2026-11-10'],
    ]);
  });

  test('dry run deletes nothing; --apply deletes only the due Google files', () => {
    put('testset/a/dsm.tif');
    put('testset/a/truth.json');
    put('testset/b/dsm.tif');
    put('verify/a.png');
    put('manifest.json', JSON.stringify({ houses: [
      { dir: 'testset/a', data: { deleteBy: '2026-10-01' } },
      { dir: 'testset/b', data: { deleteBy: '2026-12-01' } },
    ] }));
    process.env.ROOF_BENCH_DIR = root;
    const lines: string[] = [];
    try {
      expect(main(['--root', root, '--now', '2026-10-16', '--no-scratchpads'], (l) => lines.push(l))).toBe(0);
      expect(lines.some((l) => l.startsWith('would delete Google files dsm.tif in') && l.includes('testset/a'))).toBe(true);
      expect(lines.some((l) => l.includes('testset/b') && l.startsWith('would delete'))).toBe(false);
      expect(readdirSync(path.join(root, 'testset/a')).sort()).toEqual(['dsm.tif', 'truth.json']);
      expect(main(['--root', root, '--now', '2026-10-16', '--no-scratchpads', '--apply'], () => undefined)).toBe(0);
      expect(readdirSync(path.join(root, 'testset/a'))).toEqual(['truth.json']);
      expect(readdirSync(path.join(root, 'testset/b'))).toEqual(['dsm.tif']);
      expect(readdirSync(path.join(root, 'verify'))).toEqual(['a.png']); // derived images need their own flag
    } finally {
      delete process.env.ROOF_BENCH_DIR;
    }
  });

  test('arguments', () => {
    expect(parseArgs([], '2026-10-16')).toMatchObject({ apply: false, derived: false, days: 30, now: '2026-10-16', scratch: true });
    expect(parseArgs(['--days', '45'])).toMatch(/--days must be a whole number from 1 to 30/);
    expect(parseArgs(['--now', '16/10'])).toBe('--now must be YYYY-MM-DD');
    expect(parseArgs(['--delete'])).toBe('unknown argument --delete');
  });

  test('scratchpads are found two levels down', () => {
    put('claude/proj/s1/scratchpad/x.txt');
    put('claude/proj/s2/other/x.txt');
    expect(scratchpads(path.join(root, 'claude'))).toEqual([path.join(root, 'claude/proj/s1/scratchpad')]);
  });
});

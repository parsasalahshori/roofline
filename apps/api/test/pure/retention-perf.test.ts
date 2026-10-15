import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';
import type { Ring } from '@roofline/shared';
import { roofOnLayersResult } from '../../src/estimator/roof-3d.ts';
import { derivedCopies, expired, solarFolders } from '../../src/scripts/solar-data-retention.ts';
import { hipLayers } from '../roof-3d-fixture.ts';

const K = (Math.PI / 180) * 6371008.8;
const tmp = mkdtempSync(path.join(tmpdir(), 'solar-retention-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('Solar data retention (30 days)', () => {
  it('dates a folder by the manifest, else info.json, else the files; only Google files are listed', () => {
    const mk = (name: string, info?: object) => {
      const dir = path.join(tmp, 'set', name);
      mkdirSync(dir, { recursive: true });
      for (const f of ['dsm.tif', 'mask.tif', 'bi.json', 'eagleview.json']) writeFileSync(path.join(dir, f), 'x');
      if (info) writeFileSync(path.join(dir, 'info.json'), JSON.stringify(info));
      return dir;
    };
    const a = mk('a');
    mk('b', { downloadedAt: '2026-09-01' });
    const c = mk('c');
    const old = new Date('2026-08-01T00:00:00Z');
    utimesSync(path.join(c, 'dsm.tif'), old, old);
    const folders = solarFolders([tmp], new Map([[path.resolve(a), '2026-12-01']]));
    const by = Object.fromEntries(folders.map((f) => [path.basename(f.dir), f]));
    expect(by.a).toMatchObject({ deleteBy: '2026-12-01', source: 'manifest' });
    expect(by.b).toMatchObject({ deleteBy: '2026-10-01', source: 'info' });
    expect(by.c).toMatchObject({ deleteBy: '2026-08-31', source: 'mtime' });
    expect(by.a!.files).toEqual(['dsm.tif', 'mask.tif', 'bi.json']);
    expect(expired(folders, '2026-10-14').map((f) => path.basename(f.dir)).sort()).toEqual(['b', 'c']);
  });

  it('derived copies (an SVG embedding the photo, overlay PNGs) carry the earliest house date; plain SVGs and house files are not copies', () => {
    const root = path.join(tmp, 'derived');
    const house = path.join(root, 'set', 'h');
    mkdirSync(house, { recursive: true });
    writeFileSync(path.join(house, 'dsm.tif'), 'x');
    writeFileSync(path.join(house, 'info.json'), JSON.stringify({ downloadedAt: '2026-09-01' }));
    writeFileSync(path.join(house, 'note.png'), 'x');
    mkdirSync(path.join(root, 'run', 'svg'), { recursive: true });
    writeFileSync(path.join(root, 'run', 'svg', 'a.svg'), '<svg><image href="data:image/png;base64,AAAA"/></svg>');
    writeFileSync(path.join(root, 'run', 'svg', 'b.svg'), '<svg><path d="M0 0"/></svg>');
    writeFileSync(path.join(root, 'run', 'overlay.png'), 'x');
    const folders = solarFolders([root], new Map());
    const copies = derivedCopies([root], folders);
    expect(copies.map((c) => path.relative(root, c.file)).sort()).toEqual([path.join('run', 'overlay.png'), path.join('run', 'svg', 'a.svg')]);
    expect(copies.every((c) => c.deleteBy === '2026-10-01')).toBe(true);
    expect(derivedCopies([root], [])).toEqual([]);
  });
});

describe('performance budget', () => {
  it('the largest roof allowed (a 54 m square, ~2,900 m2) on the largest grid finishes within 6 s; a bigger one is refused at once', () => {
    const roof = (side: number): { ring: Ring; at: [number, number] } => {
      const dLng = side / (K * Math.cos((34.75 * Math.PI) / 180));
      const dLat = side / K;
      return {
        ring: [
          [-92.3, 34.75],
          [-92.3 + dLng, 34.75],
          [-92.3 + dLng, 34.75 + dLat],
          [-92.3, 34.75 + dLat],
          [-92.3, 34.75],
        ],
        at: [-92.3 + dLng / 2, 34.75 + dLat / 2],
      };
    };
    const big = roof(54);
    const layers = hipLayers(big.ring, { marginM: 115 - 27 });
    let t = performance.now();
    const found = roofOnLayersResult(layers, big.at);
    // Measured 1.7 s on an Apple-silicon Mac under load; the budget leaves 3.5x for a slower or busier machine.
    expect(performance.now() - t).toBeLessThan(6000);
    expect('roof' in found).toBe(true);
    const huge = roof(70);
    const hugeLayers = hipLayers(huge.ring, { marginM: 80 });
    t = performance.now();
    expect(roofOnLayersResult(hugeLayers, huge.at)).toEqual({ miss: 'too-large' });
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

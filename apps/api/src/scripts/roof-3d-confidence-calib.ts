import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Roof3d } from '@roofline/shared';
import { lngLatToUtm, utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import { crownFromGreen, eaveSupport } from '@roofline/shared/roof-reconstruct/eave-support';
import { loadHouse } from '../bench/roof3d/data.ts';
import { boundaries, geoJsonToXY, iou, type MultiPoly } from '../bench/roof3d/geometry.ts';
import { cohortsOf, parseManifest } from '../bench/roof3d/manifest.ts';
import { benchDir, FALLBACK_DATA_DIR } from '../bench/roof3d/paths.ts';
import { reconstructOnce, SEEDS } from '../bench/roof3d/run.ts';
import { outlineXY } from '../bench/roof3d/truth.ts';
import { greenOf } from '../estimator/roof-3d.ts';

/*
 * Calibration data for the confidence track (docs/roof-3d/confidence.md): every DEV house of the benchmark manifest,
 * reconstructed as the server does at seeds 7, 8, 9, with its review reasons and notes, the outline's eave support,
 * the bench's truth verdict, the EagleView outline aligned by translation (0.25 m steps, +-3 m), and per outline
 * sample its support and distance to that aligned outline. Held-out houses are refused (never tune on them).
 *
 *   npx tsx apps/api/src/scripts/roof-3d-confidence-calib.ts OUT.json [--house a,b] [--cohort NAME]
 */

const args = process.argv.slice(2);
const out = args[0];
if (out === undefined) {
  process.stderr.write('usage: roof-3d-confidence-calib OUT.json [--house a,b] [--cohort NAME]\n');
  process.exit(2);
}
const value = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = value('--house')?.split(',') ?? null;
const cohort = value('--cohort') ?? null;
const bench = benchDir();
const manifest = parseManifest(JSON.parse(readFileSync(path.join(bench, 'manifest.json'), 'utf8')));
const entries = manifest.houses.filter((h) => h.split === 'dev' && (only === null || only.includes(h.slug)) && (cohort === null || cohortsOf(h).includes(cohort)));

function translate(mp: MultiPoly, dx: number, dy: number): MultiPoly {
  return mp.map((poly) => poly.map((ring) => ring.map(([x, y]) => [x + dx, y + dy] as [number, number])));
}

function alignedEv(roof: Roof3d, ev: { type: string; coordinates: unknown }): { dx: number; dy: number; iou: number; poly: MultiPoly; zone: ReturnType<typeof outlineXY>['zone'] } {
  const { zone, poly: ours } = outlineXY(roof);
  const theirs = geoJsonToXY(zone, ev);
  let best = { dx: 0, dy: 0, iou: iou(ours, theirs) ?? 0 };
  for (let i = -12; i <= 12; i++) {
    for (let j = -12; j <= 12; j++) {
      const v = iou(ours, translate(theirs, i * 0.25, j * 0.25)) ?? 0;
      if (v > best.iou + 1e-12) best = { dx: i * 0.25, dy: j * 0.25, iou: v };
    }
  }
  return { ...best, poly: translate(theirs, best.dx, best.dy), zone };
}

function distToBoundary(p: [number, number], mp: MultiPoly): number {
  let best = Infinity;
  for (const ring of boundaries(mp)) {
    for (let i = 0; i + 1 < ring.length; i++) {
      const [ax, ay] = ring[i]!;
      const [bx, by] = ring[i + 1]!;
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
    }
  }
  return best;
}

const rows: unknown[] = [];
for (const entry of entries) {
  const h = await loadHouse(entry, bench, FALLBACK_DATA_DIR);
  const seeds = SEEDS.map((seed) => {
    const once = reconstructOnce(h, seed);
    if (once.json === 'failed' || once.json === 'no-roof') return { seed, status: once.json };
    const roof = JSON.parse(once.json) as Roof3d;
    const m = once.metrics;
    let aligned: { dx: number; dy: number; iou: number } | null = null;
    let samples: { s: string; r: string | null; c: boolean; d: number | null; e: number; drop: number | null }[] = [];
    const zone = utmZoneOfEpsg(h.layers.epsg);
    if (zone !== null) {
      const local = roof.outline.map(([lng, lat]) => {
        const u = lngLatToUtm(zone, lng, lat);
        return { x: u.easting - h.layers.originX, y: u.northing - h.layers.originY };
      });
      const raster = { width: h.layers.raster.width, height: h.layers.raster.height, pixelSizeM: h.layers.raster.pixelSizeM, dsm: h.layers.raster.dsm };
      const sup = eaveSupport(local, raster, crownFromGreen(raster, h.layers.raster.green ?? greenOf(h.layers)));
      let ev: ReturnType<typeof alignedEv> | null = null;
      if (h.eagleview !== null && m.truth?.comparable === true) {
        ev = alignedEv(roof, h.eagleview.outline as { type: string; coordinates: unknown });
        aligned = { dx: ev.dx, dy: ev.dy, iou: ev.iou };
      }
      if (sup.ok) {
        samples = sup.samples.map((q) => ({
          s: q.support,
          r: q.reason,
          c: q.canopy,
          e: q.edge,
          drop: q.dropM,
          d: ev === null ? null : Math.round(distToBoundary([h.layers.originX + q.x, h.layers.originY + q.y], ev.poly) * 1000) / 1000,
        }));
      }
    }
    return {
      seed,
      status: 'ok',
      reasons: roof.quality?.reasons ?? [],
      notes: roof.quality?.notes ?? [],
      quality: roof.quality,
      faces: roof.faces.length,
      bad: m.bad,
      truth: m.truth === null ? null : { comparable: m.truth.comparable, areaErrPct: m.truth.areaErrPct, mainPitchErr: m.truth.mainPitchErr, iou: m.truth.iou },
      aligned,
      proxy: m.proxy,
      unusable: m.unusable,
      samples,
    };
  });
  rows.push({ slug: entry.slug, cohorts: cohortsOf(entry), truth: entry.truth, seeds });
  process.stderr.write(`${entry.slug}\n`);
}
writeFileSync(out, JSON.stringify(rows));
process.stderr.write(`${rows.length} houses -> ${out}\n`);

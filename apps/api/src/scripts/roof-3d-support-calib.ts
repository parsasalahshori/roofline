import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Roof3d } from '@roofline/shared';
import { lngLatToUtm, utmToLngLat, utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import { crownFromGreen, eaveSupport } from '@roofline/shared/roof-reconstruct/eave-support';
import { loadHouse } from '../bench/roof3d/data.ts';
import { distancesToBoundary, geoJsonToXY, translate, type MultiPoly, type Pt } from '../bench/roof3d/geometry.ts';
import { lidarXY, readLidarIndex } from '../bench/roof3d/lidar.ts';
import { cohortsOf, parseManifest, withLidar } from '../bench/roof3d/manifest.ts';
import { benchDir, FALLBACK_DATA_DIR } from '../bench/roof3d/paths.ts';
import { reconstructOnce } from '../bench/roof3d/run.ts';
import { outlineXY } from '../bench/roof3d/truth.ts';
import { greenOf } from '../estimator/roof-3d.ts';

/*
 * Calibration data for the support track (docs/roof-3d/support.md): every DEV house of the benchmark manifest,
 * reconstructed as the server does (seed 7), with its review reasons, its outline evidence (quality.edgeSupport and
 * Roof3d.edges) and, per eave-support sample, its class, reason and distance to the translation-aligned EagleView
 * outline and to the translation-aligned lidar-truth outline (each where the house has that truth). The edges-unverified
 * flag and the edge confidences read only Google's layers, never lidar, so scoring them against lidar truth is not
 * circular. Held-out houses are refused (never tune on them).
 *
 *   [SUPPORT_WEAK_M=0.4] npx tsx apps/api/src/scripts/roof-3d-support-calib.ts OUT.json [--house a,b]
 */

const args = process.argv.slice(2);
const out = args[0];
if (out === undefined) {
  process.stderr.write('usage: roof-3d-support-calib OUT.json [--house a,b]\n');
  process.exit(2);
}
const value = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = value('--house')?.split(',') ?? null;
const bench = benchDir();
const manifest = withLidar(parseManifest(JSON.parse(readFileSync(path.join(bench, 'manifest.json'), 'utf8'))), readLidarIndex(bench));
const entries = manifest.houses.filter((h) => h.split === 'dev' && (only === null || only.includes(h.slug)));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

const rows: unknown[] = [];
for (const entry of entries) {
  const h = await loadHouse(entry, bench, FALLBACK_DATA_DIR);
  const once = reconstructOnce(h, 7);
  if (once.json === 'failed' || once.json === 'no-roof') {
    rows.push({ slug: entry.slug, status: once.json });
    continue;
  }
  const roof = JSON.parse(once.json) as Roof3d;
  const m = once.metrics;
  const { zone } = outlineXY(roof);
  let ev: MultiPoly | null = null;
  if (h.eagleview !== null && m.truth?.comparable === true && m.truth.aligned != null) {
    const [dx, dy] = m.truth.aligned.shiftM;
    ev = translate(geoJsonToXY(zone, h.eagleview.outline as { type: string; coordinates: unknown }), dx, dy);
  }
  let li: MultiPoly | null = null;
  if (h.lidar != null && m.lidar?.comparable === true) {
    const [dx, dy] = m.lidar.aligned.shiftM;
    li = translate(lidarXY(zone, h.lidar), dx, dy);
  }
  let samples: unknown[] = [];
  const lz = utmZoneOfEpsg(h.layers.epsg);
  if (lz !== null) {
    const local = roof.outline.map(([lng, lat]) => {
      const u = lngLatToUtm(lz, lng, lat);
      return { x: u.easting - h.layers.originX, y: u.northing - h.layers.originY };
    });
    const raster = { width: h.layers.raster.width, height: h.layers.raster.height, pixelSizeM: h.layers.raster.pixelSizeM, dsm: h.layers.raster.dsm };
    // SUPPORT_WEAK_M (sensitivity runs only) moves the per-sample weak/none line; the house's flag and edges stay the product's.
    const weakM = process.env.SUPPORT_WEAK_M === undefined ? undefined : Number(process.env.SUPPORT_WEAK_M);
    const sup = eaveSupport(local, raster, crownFromGreen(raster, h.layers.raster.green ?? greenOf(h.layers)), weakM === undefined ? {} : { weakM });
    if (sup.ok) {
      const pts: Pt[] = sup.samples.map((q) => {
        const [lng, lat] = utmToLngLat(lz, q.x + h.layers.originX, q.y + h.layers.originY);
        const u = lngLatToUtm(zone, lng, lat);
        return [u.easting, u.northing];
      });
      const dEv = ev === null ? null : distancesToBoundary(pts, ev);
      const dLi = li === null ? null : distancesToBoundary(pts, li);
      samples = sup.samples.map((q, i) => ({ e: q.edge, s: q.support, r: q.reason, c: q.canopy, drop: q.dropM, ev: dEv === null ? null : r3(dEv[i]!), li: dLi === null ? null : r3(dLi[i]!) }));
    }
  }
  rows.push({
    slug: entry.slug,
    status: 'ok',
    cohorts: cohortsOf(entry),
    reasons: roof.quality?.reasons ?? [],
    edgeSupport: roof.quality?.edgeSupport ?? null,
    edges: roof.edges ?? [],
    truth: m.truth === null || !m.truth.comparable ? null : { iou: m.truth.aligned?.iou ?? m.truth.iou, areaErrPct: m.truth.areaErrPct ?? null, grade: m.truth.grade },
    lidar: m.lidar === null || m.lidar === undefined || !m.lidar.comparable ? null : { iou: m.lidar.aligned.iou, planErrPct: m.lidar.planErrPct, truthHidden: m.lidar.truthHidden },
    samples,
  });
  process.stderr.write(`${entry.slug}\n`);
}
writeFileSync(out, JSON.stringify(rows));
process.stderr.write(`${rows.length} houses -> ${out}\n`);

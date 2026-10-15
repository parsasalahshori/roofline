import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { lngLatToUtm, reconstructRoof, utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import { type LngLat, metresToBuilding } from '@roofline/shared';
import { loadHouse } from '../bench/roof3d/data.ts';
import { readLidarIndex } from '../bench/roof3d/lidar.ts';
import { cohortsOf, parseManifest, withLidar } from '../bench/roof3d/manifest.ts';
import { benchDir } from '../bench/roof3d/paths.ts';
import { greenOf, steepRoof } from '../estimator/roof-3d.ts';
import { SOLAR_BUILDING_SNAP_M } from '../estimator/solar.ts';

/*
 * Development diagnostic for the hidden-edge 'planes' step (outline-planes.ts): per DEV house, what it changed and why
 * it declined, from the reconstruction's own summary (LocalRoof.hiddenEdge). DEV split only; never held-out houses.
 *   npx tsx src/scripts/roof-3d-planes-diag.ts [--cohort NAME] [--house a,b] [--params JSON]
 */
const argv = process.argv.slice(2);
const val = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const bench = benchDir();
let manifest = parseManifest(JSON.parse(readFileSync(path.join(bench, 'manifest.json'), 'utf8')));
manifest = withLidar(manifest, readLidarIndex(bench));
const cohort = val('--cohort') ?? 'all';
const only = val('--house')?.split(',');
const params = val('--params') !== undefined ? (JSON.parse(val('--params')!) as Record<string, number>) : undefined;
const totals: Record<string, number> = {};
for (const entry of manifest.houses) {
  if (entry.split !== 'dev') continue;
  if (only !== undefined ? !only.includes(entry.slug) : cohort !== 'all' && !cohortsOf(entry).includes(cohort)) continue;
  const h = await loadHouse(entry, bench);
  const layers = h.layers;
  const zone = utmZoneOfEpsg(layers.epsg)!;
  const s = layers.raster.pixelSizeM;
  const toPixel = ([lng, lat]: LngLat) => {
    const { easting, northing } = lngLatToUtm(zone, lng, lat);
    return { col: (easting - layers.originX) / s, row: (layers.originY - northing) / s };
  };
  const box = h.building?.box ?? null;
  const ownBox = box !== null && metresToBuilding(h.building!, entry.point) <= SOLAR_BUILDING_SNAP_M;
  const raster = { ...layers.raster, green: layers.raster.green ?? greenOf(layers) };
  const msgs: string[] = [];
  const t0 = performance.now();
  const local = reconstructRoof(raster, toPixel(entry.point), {
    imageryQuality: layers.imageryQuality,
    ...(steepRoof(h.building) ? { planes: { maxPitchX12: 24 } } : {}),
    ...(ownBox ? { building: [box.sw, [box.ne[0], box.sw[1]] as LngLat, box.ne, [box.sw[0], box.ne[1]] as LngLat].map(toPixel) } : {}),
    hiddenEdge: { method: 'planes', ...(params !== undefined ? { planes: params } : {}) },
    debug: (m) => {
      if (m.startsWith('hidden edges')) msgs.push(m);
      if (m.startsWith('hidden-edge planes') && argv.includes('--edges')) console.log('   ' + m);
    },
  });
  let ms = performance.now() - t0;
  if (argv.includes('--time')) {
    // Median of 5 runs each way, interleaved, in this process: the step's own cost without machine-load drift.
    const opts0 = {
      imageryQuality: layers.imageryQuality,
      ...(steepRoof(h.building) ? { planes: { maxPitchX12: 24 } } : {}),
      ...(ownBox ? { building: [box.sw, [box.ne[0], box.sw[1]] as LngLat, box.ne, [box.sw[0], box.ne[1]] as LngLat].map(toPixel) } : {}),
    };
    const on: number[] = [];
    const off: number[] = [];
    for (let k = 0; k < 5; k++) {
      let t = performance.now();
      reconstructRoof(raster, toPixel(entry.point), opts0);
      off.push(performance.now() - t);
      t = performance.now();
      reconstructRoof(raster, toPixel(entry.point), { ...opts0, hiddenEdge: { method: 'planes' } });
      on.push(performance.now() - t);
    }
    const med = (v: number[]) => [...v].sort((a, b) => a - b)[2]!;
    ms = med(on);
    totals.msOff = (totals.msOff ?? 0) + med(off);
    totals.msOn = (totals.msOn ?? 0) + med(on);
    console.log(`  time ${entry.slug}: off ${med(off).toFixed(1)} ms, on ${med(on).toFixed(1)} ms`);
  }
  const dump = val('--dump');
  if (dump !== undefined && local !== null) {
    const off = reconstructRoof(raster, toPixel(entry.point), {
      imageryQuality: layers.imageryQuality,
      ...(steepRoof(h.building) ? { planes: { maxPitchX12: 24 } } : {}),
      ...(ownBox ? { building: [box.sw, [box.ne[0], box.sw[1]] as LngLat, box.ne, [box.sw[0], box.ne[1]] as LngLat].map(toPixel) } : {}),
    });
    const px = (q: { x: number; y: number }) => [q.x / s, -q.y / s];
    const lid = h.lidar?.outline?.[0]?.outer?.map((ll) => toPixel(ll as LngLat)).map((q) => [q.col, q.row]) ?? null;
    writeFileSync(path.join(dump, `${entry.slug}.json`), JSON.stringify({ dir: h.dir, s, on: local.outline.map(px), off: off?.outline.map(px) ?? null, lidar: lid, faces: local.faces.map((f) => f.ring.map(px)) }));
  }
  const he = local?.hiddenEdge;
  for (const [k, v] of Object.entries(he?.declined ?? {})) totals[k] = (totals[k] ?? 0) + v;
  totals.pieces = (totals.pieces ?? 0) + (he?.pieces ?? 0);
  totals.inferredM = (totals.inferredM ?? 0) + (he?.inferredM ?? 0);
  console.log(`${entry.slug.padEnd(30)} ${cohortsOf(entry).find((c) => c.startsWith('canopy-') && c !== 'canopy-any') ?? ''} s=${s} ${ms.toFixed(0)}ms ${msgs.at(-1) ?? 'no roof'}`);
}
console.log('TOTAL', JSON.stringify(totals));

// The lidar hidden-edge method (roof-reconstruct/outline-lidar.ts) scored on EagleView, never on lidar truth (the truth
// is built from the same returns the method reads: scoring on it would be circular). docs/roof-3d/lidar.md.
//
//   npx tsx src/scripts/roof-3d-lidar-eval.ts [--split dev|heldout|all] [--reveal] [--seeds 7,8,9] [--json OUT]
//                                             [--param name=value ...] [--house a,b] [--method lidar|planes|photo|photo+planes|planes+photo]
//
// --method (default lidar) picks the hidden-edge method that is "on": the lidar step, or the hiddenEdge option's
// planes or photo method. The same frozen-shift scorer then compares all three on EagleView, the one truth none of
// them reads.
//
// Per EagleView house (comparable: one structure, IoU >= 0.5), the roof is reconstructed with the option off and on at
// the same seeds. EagleView sits about a metre off Google's frame; the shift is frozen per house from the OFF outline's
// STRONG-support samples only (the edges both sources see), so it cannot move with the method and cannot reward it for
// moving edges. Then, on both outlines, against the shifted EagleView outline:
//   hidden     our samples whose eave support is 'none' (Google cannot see the eave): distance, share within 0.5 m
//   visible    our other samples (the no-regression guard)
//   evHidden   EagleView's outline samples where Google's eave support is 'none', distance to our outline: a set fixed
//              by the key and Google's heights, so a method cannot shrink it by moving edges
//   IoU, mean boundary distance, sloped area error against the shifted key
// Held-out houses print aggregates only unless --reveal.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LngLat, Roof3d } from '@roofline/shared';
import { densify, lngLatToUtm, utmToLngLat, utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import { eaveSupport } from '@roofline/shared/roof-reconstruct/eave-support';

import { loadHouse, type LoadedHouse } from '../bench/roof3d/data.ts';
import { boundaryDistance, distancesToBoundary, geoJsonToXY, iou, type MultiPoly, type Pt, sampleRings, boundaries, translate } from '../bench/roof3d/geometry.ts';
import { readLidarEdgePoints } from '../bench/roof3d/lidar-edges.ts';
import { parseManifest } from '../bench/roof3d/manifest.ts';
import { benchDir } from '../bench/roof3d/paths.ts';
import { outlineXY } from '../bench/roof3d/truth.ts';
import { type LidarPointsUtm, roofOnLayers, steepRoof } from '../estimator/roof-3d.ts';

const WITHIN_M = 0.5;
const SHIFT_MAX_M = 3;
const SHIFT_TRUNC_M = 1;

type Edge = { n: number; sum: number; within: number };
const E0 = (): Edge => ({ n: 0, sum: 0, within: 0 });
const addD = (e: Edge, d: readonly number[]) => {
  for (const x of d) {
    e.n++;
    e.sum += x;
    if (x <= WITHIN_M) e.within++;
  }
};
const addE = (a: Edge, b: Edge) => ({ n: a.n + b.n, sum: a.sum + b.sum, within: a.within + b.within });

type Side = { iou: number; bd: number; areaErr: number; hidden: Edge; visible: Edge; evHidden: Edge; ms: number; lidar: Roof3d['lidarEdges'] | null };
type HouseResult = { slug: string; split: string; canopy: string; set: string; lidar: string; shift: [number, number]; off: Side; on: Side };

function args() {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const params: Record<string, number | boolean> = {};
  a.forEach((x, i) => {
    if (x !== '--param') return;
    const [k, v] = a[i + 1]!.split('=');
    params[k!] = v === 'true' ? true : v === 'false' ? false : Number(v);
  });
  return {
    split: get('--split') ?? 'dev',
    reveal: a.includes('--reveal'),
    seeds: (get('--seeds') ?? '7').split(',').map(Number),
    json: get('--json'),
    houses: get('--house')?.split(',') ?? null,
    params,
    method: (get('--method') ?? 'lidar') as 'lidar' | 'planes' | 'photo' | 'photo+planes' | 'planes+photo',
  };
}

/** Google's eave support (strong/weak/none) of every 0.2 m sample (one per 0.2 m piece) along a lng/lat ring, as bench metres. */
function supportOf(ring: readonly LngLat[], h: LoadedHouse, zone: ReturnType<typeof outlineXY>['zone']): { p: Pt; cls: string }[] | null {
  const L = h.layers;
  const lz = utmZoneOfEpsg(L.epsg);
  if (lz === null) return null;
  const local = ring.map(([lng, lat]) => {
    const u = lngLatToUtm(lz, lng, lat);
    return { x: u.easting - L.originX, y: u.northing - L.originY };
  });
  const r = L.raster;
  // In 0.2 m pieces: eaveSupport (c606b7a4) puts every sample past an edge's midpoint at the midpoint.
  const s = eaveSupport(densify(local, 0.2).pts, { width: r.width, height: r.height, pixelSizeM: r.pixelSizeM, dsm: r.dsm }, null, { stepM: 0.2 });
  if (!s.ok) return null;
  return s.samples.map((q) => {
    const [lng, lat] = utmToLngLat(lz, q.x + L.originX, q.y + L.originY);
    const u = lngLatToUtm(zone, lng, lat);
    return { p: [u.easting, u.northing] as Pt, cls: q.support };
  });
}

/** EagleView's shift onto Google's frame from the strong samples of `roof` (grid 0.1 m within 3 m, truncated mean distance). */
function frozenShift(strong: readonly Pt[], ev: MultiPoly): [number, number] {
  if (strong.length < 20) return [0, 0];
  const pts = strong.filter((_, i) => i % Math.max(1, Math.floor(strong.length / 400)) === 0);
  let best: [number, number, number] = [0, 0, Infinity];
  const cost = (dx: number, dy: number) => {
    // Moving the key by (dx, dy) is moving the points by (-dx, -dy).
    const d = distancesToBoundary(pts.map(([x, y]) => [x - dx, y - dy] as Pt), ev);
    return d.reduce((t, x) => t + Math.min(SHIFT_TRUNC_M, x), 0) / d.length;
  };
  for (let dy = -SHIFT_MAX_M; dy <= SHIFT_MAX_M + 1e-9; dy += 0.25) {
    for (let dx = -SHIFT_MAX_M; dx <= SHIFT_MAX_M + 1e-9; dx += 0.25) {
      const c = cost(dx, dy);
      if (c < best[2]) best = [dx, dy, c];
    }
  }
  const [cx, cy] = best;
  for (let dy = cy - 0.3; dy <= cy + 0.3 + 1e-9; dy += 0.05) {
    for (let dx = cx - 0.3; dx <= cx + 0.3 + 1e-9; dx += 0.05) {
      const c = cost(dx, dy);
      if (c < best[2]) best = [dx, dy, c];
    }
  }
  return [Math.round(best[0] * 100) / 100, Math.round(best[1] * 100) / 100];
}

function side(h: LoadedHouse, roof: Roof3d | null, ev: MultiPoly, evHiddenPts: readonly Pt[], ms: number): Side | null {
  if (roof === null) return null;
  const { zone, poly } = outlineXY(roof);
  const sup = supportOf(roof.outline, h, zone);
  const hidden = E0();
  const visible = E0();
  if (sup !== null) {
    addD(hidden, distancesToBoundary(sup.filter((q) => q.cls === 'none').map((q) => q.p), ev));
    addD(visible, distancesToBoundary(sup.filter((q) => q.cls !== 'none').map((q) => q.p), ev));
  }
  const evHidden = E0();
  addD(evHidden, distancesToBoundary(evHiddenPts, poly));
  const sloped = roof.faces.reduce((t, f) => t + f.slopedAreaSqFt, 0);
  const evSloped = h.eagleview!.total_sloped_sqft;
  return {
    iou: iou(poly, ev) ?? 0,
    bd: boundaryDistance(poly, ev, 0.2).mean,
    areaErr: evSloped > 0 ? (100 * (sloped - evSloped)) / evSloped : Number.NaN,
    hidden,
    visible,
    evHidden,
    ms,
    lidar: roof.lidarEdges ?? null,
  };
}

function mean(xs: readonly number[]) {
  return xs.length === 0 ? Number.NaN : xs.reduce((t, x) => t + x, 0) / xs.length;
}
function med(xs: readonly number[]) {
  if (xs.length === 0) return Number.NaN;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

async function main() {
  const o = args();
  const bench = benchDir();
  const m = parseManifest(JSON.parse(readFileSync(path.join(bench, 'manifest.json'), 'utf8')));
  const out: HouseResult[] = [];
  let withLidarFile = 0;
  for (const e of m.houses) {
    if (o.houses !== null && !o.houses.includes(e.slug)) continue;
    if (o.split !== 'all' && e.split !== o.split) continue;
    if (e.split === 'heldout' && o.houses !== null && !o.reveal) throw new Error('held-out houses need --reveal');
    const h = await loadHouse(e, bench);
    if (h.eagleview === null) continue;
    const lp = readLidarEdgePoints(bench, e.slug, e.data?.imageryDate ?? null);
    if (lp !== null) withLidarFile++;
    const points: LidarPointsUtm | null = lp?.points ?? null;
    for (const seed of o.seeds) {
      const base = { steep: steepRoof(h.building), building: h.building, seed };
      let t = performance.now();
      // Off: no hidden-edge step at all (the server's default runs one since ROOF_3D_ALGORITHM_VERSION 4).
      const off = roofOnLayers(h.layers, e.point, { ...base, hiddenEdge: null });
      const msOff = performance.now() - t;
      t = performance.now();
      const on =
        o.method === 'lidar'
          ? points === null
            ? off
            : roofOnLayers(h.layers, e.point, { ...base, hiddenEdge: null, lidar: points, lidarParams: o.params })
          : roofOnLayers(h.layers, e.point, { ...base, hiddenEdge: { method: o.method, planes: o.params as Record<string, number>, photo: o.params as Record<string, number> } });
      const msOn = performance.now() - t;
      if (off === null || on === null) continue;
      const { zone, poly: oursOff } = outlineXY(off);
      const ev0 = geoJsonToXY(zone, h.eagleview.outline);
      if ((iou(oursOff, ev0) ?? 0) < 0.5 || h.eagleview.structures !== 1) continue;
      const sup = supportOf(off.outline, h, zone);
      const shift = frozenShift(sup?.filter((q) => q.cls === 'strong').map((q) => q.p) ?? [], ev0);
      const ev = translate(ev0, shift[0], shift[1]);
      // EagleView's own outline samples, in Google's frame, where Google's heights cannot see an eave.
      const evRingsLL: LngLat[][] = boundaries(ev).map((r) => r.map(([x, y]) => utmToLngLat(zone, x, y) as LngLat));
      const evHiddenPts: Pt[] = [];
      for (const r of evRingsLL) for (const q of supportOf(r, h, zone) ?? []) if (q.cls === 'none') evHiddenPts.push(q.p);
      void sampleRings;
      const a = side(h, off, ev, evHiddenPts, msOff);
      const b = side(h, on, ev, evHiddenPts, msOn);
      if (a === null || b === null) continue;
      out.push({
        slug: e.slug,
        split: e.split,
        canopy: e.tags.canopy?.class ?? 'none',
        set: e.set,
        lidar: o.method !== 'lidar' ? (JSON.stringify(on.outline) === JSON.stringify(off.outline) ? 'unchanged' : 'applied') : points === null ? 'no-crop' : b.lidar?.applied ? 'applied' : (b.lidar?.reason ?? 'none'),
        shift,
        off: a,
        on: b,
      });
    }
  }
  const cohorts: [string, (r: HouseResult) => boolean][] = [
    ['all', () => true],
    ['canopy-heavy', (r) => r.canopy === 'heavy'],
    ['canopy-light', (r) => r.canopy === 'light'],
    ['canopy-none', (r) => r.canopy === 'none'],
    ['tree set', (r) => r.set === 'testset-trees'],
    ['lidar applied', (r) => r.lidar === 'applied'],
  ];
  const fmtE = (x: Edge) => (x.n === 0 ? '-' : `${x.n} ${(x.sum / x.n).toFixed(2)} m ${((100 * x.within) / x.n).toFixed(0)}%`);
  const lines: string[] = [];
  const splits = o.split === 'all' ? ['dev', 'heldout'] : [o.split];
  const summary: Record<string, unknown> = {};
  for (const sp of splits) {
    const rs = out.filter((r) => r.split === sp);
    const nH = new Set(rs.map((r) => r.slug)).size;
    lines.push(`\n== ${sp} (method ${o.method}): ${nH} comparable EagleView houses (${withLidarFile} EagleView houses with a lidar crop in the run), seeds ${o.seeds.join(',')}`);
    const reasons: Record<string, number> = {};
    for (const r of rs) reasons[r.lidar] = (reasons[r.lidar] ?? 0) + 1;
    lines.push(`lidar outcome (house-seeds): ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    lines.push('cohort         | houses | hidden off -> on (n mean <=0.5) | evHidden off -> on | visible off -> on | med IoU off -> on | med bd | med |area err| | ms p50 off/on');
    for (const [name, f] of cohorts) {
      const c = rs.filter(f);
      if (c.length === 0) continue;
      const hs = new Set(c.map((r) => r.slug)).size;
      if (sp === 'heldout' && !o.reveal && hs < 5) {
        lines.push(`${name.padEnd(14)} | ${hs} (under 5: aggregate withheld)`);
        continue;
      }
      const agg = (k: 'off' | 'on', key: 'hidden' | 'visible' | 'evHidden') => c.reduce((t, r) => addE(t, r[k][key]), E0());
      const row = {
        houses: hs,
        hidden: [agg('off', 'hidden'), agg('on', 'hidden')],
        evHidden: [agg('off', 'evHidden'), agg('on', 'evHidden')],
        visible: [agg('off', 'visible'), agg('on', 'visible')],
        iou: [med(c.map((r) => r.off.iou)), med(c.map((r) => r.on.iou))],
        bd: [med(c.map((r) => r.off.bd)), med(c.map((r) => r.on.bd))],
        area: [med(c.map((r) => Math.abs(r.off.areaErr))), med(c.map((r) => Math.abs(r.on.areaErr)))],
        signedArea: [mean(c.map((r) => r.off.areaErr)), mean(c.map((r) => r.on.areaErr))],
        ms: [med(c.map((r) => r.off.ms)), med(c.map((r) => r.on.ms))],
      };
      summary[`${sp}/${name}`] = row;
      lines.push(
        `${name.padEnd(14)} | ${String(hs).padStart(6)} | ${fmtE(row.hidden[0]!)} -> ${fmtE(row.hidden[1]!)} | ${fmtE(row.evHidden[0]!)} -> ${fmtE(row.evHidden[1]!)} | ${fmtE(row.visible[0]!)} -> ${fmtE(row.visible[1]!)} | ${row.iou[0]!.toFixed(3)} -> ${row.iou[1]!.toFixed(3)} | ${row.bd[0]!.toFixed(2)} -> ${row.bd[1]!.toFixed(2)} | ${row.area[0]!.toFixed(1)} -> ${row.area[1]!.toFixed(1)} (signed mean ${row.signedArea[0]!.toFixed(1)} -> ${row.signedArea[1]!.toFixed(1)}) | ${row.ms[0]!.toFixed(0)}/${row.ms[1]!.toFixed(0)}`,
      );
    }
    if (sp === 'dev' || o.reveal) {
      lines.push('house                     canopy set              lidar           shift       IoU off->on   bd off->on  area% off->on  hidden<=0.5 off->on  evHidden<=0.5 off->on  moved');
      for (const r of rs) {
        const pct = (e: Edge) => (e.n === 0 ? '  -' : `${((100 * e.within) / e.n).toFixed(0).padStart(3)}%/${e.n}`);
        lines.push(
          `${r.slug.padEnd(25)} ${r.canopy.padEnd(6)} ${r.set.padEnd(16)} ${r.lidar.padEnd(15)} ${r.shift.map((x) => x.toFixed(2)).join(',').padEnd(11)} ${r.off.iou.toFixed(3)}->${r.on.iou.toFixed(3)} ${r.off.bd.toFixed(2)}->${r.on.bd.toFixed(2)} ${r.off.areaErr.toFixed(1)}->${r.on.areaErr.toFixed(1)}  ${pct(r.off.hidden)} -> ${pct(r.on.hidden)}  ${pct(r.off.evHidden)} -> ${pct(r.on.evHidden)}  ${(r.on.lidar?.moved ?? []).map((q) => (q.offsetFt / 3.2808).toFixed(2)).join(' ')}`,
        );
      }
    }
  }
  console.log(lines.join('\n'));
  if (o.json !== undefined) writeFileSync(o.json, JSON.stringify({ args: o, summary, houses: o.reveal ? out : out.filter((r) => r.split === 'dev') }, null, 1));
}

await main();

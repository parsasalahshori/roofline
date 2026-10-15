// Lidar fusion (roof-reconstruct/lidar-fusion.ts) scored without circularity: the fusion reads ONE lidar flight per
// house (lidar-edges/<slug>.bin, picked from metadata alone: leaf-off first, latest, most points), so it is scored on
//   EagleView           the sandbox reports (independent of all lidar), and
//   cross-flight truth  the lidar outline built from a DIFFERENT flight of the same house (lidar/<slug>/units/<u>/truth.json
//                       with u != the fused flight's work unit), never the flight it read.
// The single-flight lidar grade (lidar/<slug>/truth.json, built from the fused flight on most houses) is never used here.
//
// Each truth is compared with the fusion OFF and ON at the same seed; the key's shift onto Google's frame is frozen from
// the OFF outline (alignedOutline), so it cannot move with the method. Per house: IoU (frozen shift), plan area error
// (ours - truth) / truth, and the fusion's report. Held-out houses only with --reveal (the integrator and verifiers).
//
//   npx tsx src/scripts/roof-3d-fusion-eval.ts [--split dev|heldout|all] [--reveal] [--house a,b] [--json OUT] [--param name=value ...]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Roof3d } from '@roofline/shared';
import { loadHouse } from '../bench/roof3d/data.ts';
import { area, geoJsonToXY, iou, type MultiPoly, ringToXY, translate } from '../bench/roof3d/geometry.ts';
import { readLidarEdgePoints } from '../bench/roof3d/lidar-edges.ts';
import { parseManifest } from '../bench/roof3d/manifest.ts';
import { benchDir } from '../bench/roof3d/paths.ts';
import { alignedOutline, outlineXY } from '../bench/roof3d/truth.ts';
import { roofOnLayers, steepRoof } from '../estimator/roof-3d.ts';

type Score = { iou: number; planErrPct: number };
type Row = {
  slug: string;
  split: string;
  canopy: string;
  fused: string | null;
  report: Roof3d["lidarFusion"] | null;
  reasonsOn: string[];
  ev: { off: Score; on: Score } | null;
  xflight: { unit: string; end: string | null; density: number | null; off: Score; on: Score }[];
};

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
  return { split: get('--split') ?? 'dev', reveal: a.includes('--reveal'), houses: get('--house')?.split(',') ?? null, json: get('--json'), params };
}

/** The other flights' lidar outlines of a house (truth.json per work unit, ok only), lng/lat polygons. */
function otherFlights(bench: string, slug: string, fusedUnit: string | null): { unit: string; end: string | null; density: number | null; outline: { outer: number[][]; holes: number[][][] }[] }[] {
  const dir = path.join(bench, 'lidar', slug, 'units');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const u of readdirSync(dir).sort()) {
    if (u === fusedUnit) continue;
    const f = path.join(dir, u, 'truth.json');
    if (!existsSync(f)) continue;
    const t = JSON.parse(readFileSync(f, 'utf8')) as { ok?: boolean; outline?: { outer: number[][]; holes: number[][][] }[]; source?: { collect?: string[] }; checks?: { roofPointsPerM2?: number } };
    if (t.ok !== true || !Array.isArray(t.outline) || t.outline.length === 0) continue;
    out.push({ unit: u, end: t.source?.collect?.at(-1) ?? null, density: t.checks?.roofPointsPerM2 ?? null, outline: t.outline });
  }
  return out;
}

function score(ours: MultiPoly, truth: MultiPoly, shift: [number, number]): Score {
  const t = translate(truth, shift[0], shift[1]);
  const at = area(t);
  return { iou: Math.round((iou(ours, t) ?? 0) * 1000) / 1000, planErrPct: at > 0 ? Math.round((1000 * (area(ours) - at)) / at) / 10 : Number.NaN };
}

async function main() {
  const o = args();
  const bench = benchDir();
  const m = parseManifest(JSON.parse(readFileSync(path.join(bench, 'manifest.json'), 'utf8')));
  const rows: Row[] = [];
  for (const e of m.houses) {
    if (o.houses !== null && !o.houses.includes(e.slug)) continue;
    if (o.split !== 'all' && e.split !== o.split) continue;
    if (e.split === 'heldout' && !o.reveal) continue;
    const lp = readLidarEdgePoints(bench, e.slug, e.data?.imageryDate ?? null);
    if (lp === null) continue;
    const h = await loadHouse(e, bench);
    const base = { steep: steepRoof(h.building), building: h.building, seed: 7, hiddenEdge: null };
    const off = roofOnLayers(h.layers, e.point, base);
    const on = roofOnLayers(h.layers, e.point, { ...base, lidarFusion: { points: lp.points, params: o.params } });
    if (off === null || on === null) continue;
    const { zone, poly: pOff } = outlineXY(off);
    const pOn = outlineXY(on).poly;
    let ev: Row['ev'] = null;
    if (h.eagleview !== null && h.eagleview.structures === 1) {
      const evp = geoJsonToXY(zone, h.eagleview.outline);
      if ((iou(pOff, evp) ?? 0) >= 0.5) {
        const sh = alignedOutline(pOff, evp, 0.2).shiftM;
        ev = { off: score(pOff, evp, sh), on: score(pOn, evp, sh) };
      }
    }
    const xflight: Row['xflight'] = [];
    for (const f of otherFlights(bench, e.slug, lp.info.workunit)) {
      const tp: MultiPoly = f.outline.map((p) => [ringToXY(zone, p.outer), ...p.holes.map((hh) => ringToXY(zone, hh))]);
      if ((iou(pOff, tp) ?? 0) < 0.5) continue;
      const sh = alignedOutline(pOff, tp, 0.2).shiftM;
      xflight.push({ unit: f.unit, end: f.end, density: f.density, off: score(pOff, tp, sh), on: score(pOn, tp, sh) });
    }
    rows.push({ slug: e.slug, split: e.split, canopy: e.tags.canopy?.class ?? '-', fused: lp.info.workunit, report: on.lidarFusion ?? null, reasonsOn: on.quality?.reasons ?? [], ev, xflight });
  }
  const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-');
  const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '-');
  process.stdout.write('house                           | fusion                  | +plan ft2 | EV IoU off->on | EV plan% off->on | xflight unit (end)                 | IoU off->on   | plan% off->on\n');
  for (const r of rows) {
    const rep0 = r.report == null ? '-' : r.report.applied ? `added ${(r.report.addedShare * 100).toFixed(1)}%` : `declined ${r.report.reason ?? ''}`;
    const evs = r.ev === null ? ['-', '-'] : [`${f3(r.ev.off.iou)}->${f3(r.ev.on.iou)}`, `${f1(r.ev.off.planErrPct)}->${f1(r.ev.on.planErrPct)}`];
    const xs = r.xflight.length === 0 ? [{ u: '-', i: '-', p: '-' }] : r.xflight.map((x) => ({ u: `${x.unit} (${x.end ?? '?'}, ${x.density ?? '?'}/m2)`, i: `${f3(x.off.iou)}->${f3(x.on.iou)}`, p: `${f1(x.off.planErrPct)}->${f1(x.on.planErrPct)}` }));
    xs.forEach((x, k) =>
      process.stdout.write(
        `${(k === 0 ? `${r.slug} ${r.canopy}` : '').padEnd(31)} | ${(k === 0 ? rep0 : '').padEnd(23)} | ${(k === 0 ? f1(r.report?.addedPlanSqFt ?? 0) : '').padStart(9)} | ${(k === 0 ? evs[0]! : '').padEnd(14)} | ${(k === 0 ? evs[1]! : '').padEnd(16)} | ${x.u.padEnd(34)} | ${x.i.padEnd(13)} | ${x.p}\n`,
      ),
    );
  }
  const applied = rows.filter((r) => r.report?.applied === true);
  const changedEv = rows.filter((r) => r.ev !== null && (r.ev.on.iou !== r.ev.off.iou || r.ev.on.planErrPct !== r.ev.off.planErrPct));
  const xs = rows.flatMap((r) => r.xflight.map((x) => ({ r, x })));
  const xsChanged = xs.filter(({ x }) => x.on.iou !== x.off.iou);
  const medAbs = (v: number[]) => {
    const a = v.map(Math.abs).sort((p, q) => p - q);
    return a.length === 0 ? Number.NaN : a[a.length >> 1]!;
  };
  process.stdout.write(
    `\n${rows.length} houses with a lidar crop; fusion applied on ${applied.length}; EagleView houses changed ${changedEv.length}; cross-flight pairs ${xs.length} (changed ${xsChanged.length}).\n` +
      `EagleView changed: IoU better ${changedEv.filter((r) => r.ev!.on.iou > r.ev!.off.iou).length}, worse ${changedEv.filter((r) => r.ev!.on.iou < r.ev!.off.iou).length}.\n` +
      `Cross-flight changed: IoU better ${xsChanged.filter(({ x }) => x.on.iou > x.off.iou).length}, worse ${xsChanged.filter(({ x }) => x.on.iou < x.off.iou).length}; median |plan err| off ${f1(medAbs(xs.map(({ x }) => x.off.planErrPct)))}% on ${f1(medAbs(xs.map(({ x }) => x.on.planErrPct)))}%.\n` +
      `Declines: ${JSON.stringify(rows.reduce<Record<string, number>>((t, r) => ((t[r.report?.applied ? 'applied' : (r.report?.reason ?? 'none')] = (t[r.report?.applied ? 'applied' : (r.report?.reason ?? 'none')] ?? 0) + 1), t), {}))}\n`,
  );
  if (o.json !== undefined) writeFileSync(o.json, JSON.stringify(rows, null, 1));
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

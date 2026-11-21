// Hip ends: the face that drains to an eave of the outline where the faces have none. One of the fitted shapes
// (fitted-shapes.ts, which places a shape's faces and checks what topology draws of them).
//
// A hip roof's end face is a triangle a few metres across. The height map blurs it into the two long slopes, the plane
// search gives its pixels to them, and the roof reads as a gable there: the two hips are missing (or come out short),
// and the end's eave is named by the heights beside it (topology.ts, measuredEdge) with no face of its own behind it.
// The outline is sharp where the height map is not, and every eave has a face that drains to it. Model fitting, from
// each straight edge of the outline:
//
// 1. The eave. Beside the edge (a band a metre wide, clear of the rounded-off edge itself, and inside the 45 degree
//    lines from the edge's ends, where an end face would lie) the heights climb away from the edge on one plane and
//    run level along it, while the faces' own planes there do not climb that way.
// 2. The face. The plane through the eave (two numbers: the eave's height and the pitch; level along the edge), least
//    squares on the heights it holds, walked in from the edge column by column for as long as the heights stay on it:
//    to the hips, where the roof beyond falls away under the plane.
// 3. The evidence. Over its footprint the plane must explain the heights better than the faces' planes do, by a margin
//    (ShapeParams.shapeGainM). An eave whose face is already there gains nothing.
import { median, type ShapeParams, type ShapeProposal, type ShapeScene } from './fitted-shapes.ts';
import { signedArea, type XY } from './geom.ts';
import { pixelX, pixelY } from './planes.ts';

/** A corner of an end face: where a column's slope is too short to be seen, the pixels inside the 45 degree line (plus this, metres) and under the faces' planes. */
const CORNER_SLACK_M = 0.2;
/** Behind a corner where the outline turns inward, a column's face begins within this (metres) of the 45 degree line from the corner. */
const CORNER_LEAD_M = 0.6;

/** Least squares z = c0 + c1 * d (+ c2 * t when `along`), on the rows whose residual against `from` is within `tol` (all rows when null). */
function fitBand(rows: readonly { t: number; d: number; z: number }[], along: boolean, from: { h: number; q: number; r: number } | null, tol: number): { h: number; q: number; r: number; n: number } | null {
  let n = 0;
  let sd = 0;
  let st = 0;
  let sz = 0;
  let sdd = 0;
  let stt = 0;
  let sdt = 0;
  let sdz = 0;
  let stz = 0;
  for (const p of rows) {
    if (from !== null && Math.abs(p.z - (from.h + from.q * p.d + from.r * p.t)) > tol) continue;
    n++;
    sd += p.d;
    st += p.t;
    sz += p.z;
    sdd += p.d * p.d;
    stt += p.t * p.t;
    sdt += p.d * p.t;
    sdz += p.d * p.z;
    stz += p.t * p.z;
  }
  if (n < 20) return null;
  // Centred sums.
  const cdd = sdd - (sd * sd) / n;
  const ctt = stt - (st * st) / n;
  const cdt = sdt - (sd * st) / n;
  const cdz = sdz - (sd * sz) / n;
  const ctz = stz - (st * sz) / n;
  if (!along) {
    if (!(cdd > 1e-9)) return null;
    const q = cdz / cdd;
    return { h: (sz - q * sd) / n, q, r: 0, n };
  }
  const det = cdd * ctt - cdt * cdt;
  if (!(det > 1e-9)) return null;
  const q = (cdz * ctt - ctz * cdt) / det;
  const r = (ctz * cdd - cdz * cdt) / det;
  return { h: (sz - q * sd - r * st) / n, q, r, n };
}

/** Eaves of the outline with no face draining to them, each with the face fitted through it and its evidence. */
export function findHipEnds(scene: ShapeScene, prm: ShapeParams, debug?: (msg: string) => void): ShapeProposal[] {
  const { g, s, dsm, labels, model, index, usable, maxX12 } = scene;
  const n = g.w * g.h;
  // Counter-clockwise: the roof is on the left of every edge.
  const ring = signedArea(scene.outline) >= 0 ? scene.outline : [...scene.outline].reverse();
  const found: ShapeProposal[] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k]!;
    const b = ring[(k + 1) % ring.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < prm.hipEdgeM) continue;
    const ex = (b.x - a.x) / len;
    const ey = (b.y - a.y) / len;
    const nx = -ey;
    const ny = ex;
    const at = (t: number, d: number) => index(a.x + t * ex + d * nx, a.y + t * ey + d * ny);
    // 1. The band beside the edge: the heights and the faces' planes there, as planes.
    const rows: { t: number; d: number; z: number }[] = [];
    const rowsModel: { t: number; d: number; z: number }[] = [];
    for (let t = s / 2; t < len; t += s) {
      const reach = Math.min(prm.hipBandOutM, 0.8 * Math.min(t, len - t));
      for (let d = prm.hipBandInM; d <= reach + 1e-9; d += s) {
        const i = at(t, d);
        if (!usable(i) || labels[i]! < 0) continue;
        rows.push({ t, d, z: dsm[i]! });
        rowsModel.push({ t, d, z: model[i]! });
      }
    }
    const free0 = fitBand(rows, true, null, 0);
    const free = free0 === null ? null : fitBand(rows, true, free0, 0.15);
    if (free === null || free.n < 0.6 * rows.length) continue;
    if (!(free.q * 12 >= prm.shapeMinX12 && free.q * 12 <= maxX12) || Math.abs(free.r) > prm.hipAlongShare * free.q) continue;
    let fit = fitBand(rows, false, free, 0.15);
    if (fit === null) continue;
    // The faces' own planes in the band: climbing away from the edge as the heights do, and at their height, the face is there.
    const mine = fitBand(rowsModel, true, null, 0);
    const apart = median(rowsModel.map((p) => Math.abs(p.z - (fit!.h + fit!.q * p.d))));
    if (mine !== null && mine.q >= 0.7 * fit.q && apart <= 0.1) continue;
    const where = `eave at ${(a.x + (len / 2) * ex).toFixed(1)},${(a.y + (len / 2) * ey).toFixed(1)} (${len.toFixed(1)} m)`;
    // 2. The face walked in from the edge, column by column, and its plane refitted on the heights it holds. Past an
    //    end of the edge where the outline turns inward (a bump-out's side meets the main wall) the face runs on, in
    //    behind the corner, to the valley where the roof beyond takes over: the columns go on past that end, each
    //    starting at the 45 degree line from the corner (give or take), for as long as they find the face.
    const cols = Math.max(1, Math.round(len / s));
    const turnsIn = (corner: XY, from: XY, to: XY): boolean => (corner.x - from.x) * (to.y - corner.y) - (corner.y - from.y) * (to.x - corner.x) < 0;
    const pastLo = turnsIn(a, ring[(k + ring.length - 1) % ring.length]!, b) ? Math.round(prm.shapeMaxRunM / s) : 0;
    const pastHi = turnsIn(b, a, ring[(k + 2) % ring.length]!) ? Math.round(prm.shapeMaxRunM / s) : 0;
    const run = new Float32Array(pastLo + cols + pastHi).fill(-1);
    const overOf = (c: number) => (c < 0 ? -c * s : c >= cols ? (c - cols + 1) * s : 0);
    const walkOne = (c: number, h: number, q: number, take?: (d: number, z: number) => void): number => {
      const t = (c + 0.5) * s;
      const over = overOf(c);
      let last = 0;
      let bad = 0;
      let started = over === 0;
      for (let j = Math.max(0, Math.floor((over - CORNER_LEAD_M) / s)); (j + 0.5) * s <= prm.shapeMaxRunM; j++) {
        const d = (j + 0.5) * s;
        const i = at(t, d);
        if (!usable(i)) {
          // The outline may lie a few pixels outside the mask, and a crown may hang over the eave.
          if (over === 0 && d < prm.shapeRoundM) continue;
          break;
        }
        const dev = dsm[i]! - (h + q * d);
        // By the edge the height map falls away into the yard: any height under the plane is the eave rounded off.
        const ok = over === 0 && d < prm.shapeRoundM ? dev <= prm.shapeTolM : Math.abs(dev) <= prm.shapeTolM;
        if (ok) {
          started = true;
          last = d;
          bad = 0;
          if (over > 0 || d >= prm.shapeRoundM) take?.(d, dsm[i]!);
        } else if (!started) {
          // Behind the corner: the roof beyond, until the face begins.
          if (d > over + CORNER_LEAD_M) break;
        } else if (++bad >= 3) break;
      }
      return over === 0 ? (last >= prm.shapeRoundM ? last : -1) : last - Math.max(0, over - CORNER_LEAD_M) >= prm.shapeRoundM ? last : -1;
    };
    const walk = (h: number, q: number, take?: (d: number, z: number) => void): void => {
      run.fill(-1);
      for (let c = 0; c < cols; c++) run[pastLo + c] = walkOne(c, h, q, take);
      const stop = Math.max(1, Math.round(0.3 / s));
      for (let c = -1, miss = 0; c >= -pastLo && miss <= stop; c--) {
        const r = walkOne(c, h, q, take);
        run[pastLo + c] = r;
        miss = r < 0 ? miss + 1 : 0;
      }
      for (let c = cols, miss = 0; c < cols + pastHi && miss <= stop; c++) {
        const r = walkOne(c, h, q, take);
        run[pastLo + c] = r;
        miss = r < 0 ? miss + 1 : 0;
      }
    };
    let failed = '';
    for (let it = 0; it < 2 && failed === ''; it++) {
      const held: { t: number; d: number; z: number }[] = [];
      walk(fit.h, fit.q, (d, z) => held.push({ t: 0, d, z }));
      const next = fitBand(held, false, null, 0);
      if (next === null) failed = 'the heights leave the plane at once';
      else if (!(next.q * 12 >= prm.shapeMinX12 && next.q * 12 <= maxX12)) failed = `pitch ${(next.q * 12).toFixed(1)}/12`;
      else fit = next;
    }
    if (failed !== '') {
      debug?.(`hip end: ${where}: no face (${failed})`);
      continue;
    }
    walk(fit.h, fit.q);
    const { h, q } = fit;
    const reach = median([...run.subarray(pastLo, pastLo + cols)].filter((d) => d >= 0));
    if (!(q * reach >= prm.shapeReliefM)) {
      debug?.(`hip end: ${where}: ${(q * 12).toFixed(1)}/12, not kept (it climbs ${Number.isFinite(reach) ? (q * reach).toFixed(2) : '0'} m)`);
      continue;
    }
    // 3. The footprint and the evidence.
    const px: number[] = [];
    let gainSum = 0;
    for (let i = 0; i < n; i++) {
      if (!usable(i) || labels[i]! < 0) continue;
      const rx = pixelX(g, s, i) - a.x;
      const ry = pixelY(g, s, i) - a.y;
      const t = rx * ex + ry * ey;
      const d = rx * nx + ry * ny;
      const c = Math.floor(t / s);
      if (c < -pastLo || c >= cols + pastHi || d < -0.5 || d > prm.shapeMaxRunM) continue;
      const far = run[pastLo + c]!;
      const over = overOf(c);
      const z = h + q * Math.max(0, d);
      const eT = Math.min(1, Math.abs(dsm[i]! - z));
      const eM = Math.min(1, Math.abs(dsm[i]! - model[i]!));
      let inside: boolean;
      if (over > 0) {
        // Behind a corner: where the plane lies at least as close to the heights as the faces' planes do.
        inside = far >= 0 && d >= over - CORNER_LEAD_M && d <= far + s / 2 && eT <= eM + 0.02;
      } else if (far >= 0 && d <= far + s / 2) {
        // The face's where its plane lies at least as close to the heights as the faces' planes do, or under them (an
        // end face cuts the long slopes off: they run on above it); by the edge the height map is rounded off under both.
        inside = d < prm.shapeRoundM || z <= model[i]! + 0.02 || eT <= eM + 0.02;
      } else {
        // A corner of an end face, where a column's slope is too short to be seen: inside the 45 degree line, under the faces' planes.
        inside = far < 0 && d <= Math.min(t, len - t) + CORNER_SLACK_M && z <= model[i]! + 0.02;
      }
      if (!inside) continue;
      px.push(i);
      gainSum += eM - eT;
    }
    const areaM2 = px.length * s * s;
    if (areaM2 < prm.shapeMinM2) {
      debug?.(`hip end: ${where}: ${(q * 12).toFixed(1)}/12, not kept (footprint ${areaM2.toFixed(1)} m2)`);
      continue;
    }
    const gain = gainSum / px.length;
    if (gain < prm.shapeGainM) {
      debug?.(`hip end: ${where}: ${(q * 12).toFixed(1)}/12, not kept (the faces explain the heights nearly as well: gain ${gain.toFixed(2)} m over ${areaM2.toFixed(1)} m2)`);
      continue;
    }
    debug?.(`hip end: ${where}: ${(q * 12).toFixed(1)}/12, footprint ${areaM2.toFixed(1)} m2, gain ${gain.toFixed(2)} m`);
    found.push({
      kind: 'hip-end',
      at: { x: a.x + (len / 2) * ex + nx, y: a.y + (len / 2) * ey + ny },
      pitchX12: q * 12,
      sides: [{ px: Int32Array.from(px), plane: { a: q * nx, b: q * ny, c: h - q * (a.x * nx + a.y * ny) }, gain }],
      gain,
      areaM2,
    });
  }
  return found;
}

// Moving the person's rough window corners onto the frame's real edges.
// For each side of the rough quad: grey profiles across the side at many points along it, within a band (about 3%
// of the photo) either side; every straight line through the band is scored by the edge strength along it (a 2D
// search over the line's offset at both ends, so a rough side that is tilted relative to the real edge still finds
// it). A window frame has several parallel edges (trim, frame, sash, glass): the candidates are the score's local
// maxima, and the one picked is the closest to the person's line among the strong ones, with one brightness
// polarity for all four sides (the same boundary all round). The picked edge is then located to a fraction of a pixel
// at every profile (centroid of the derivative), a trimmed total-least-squares line is fitted, and corners are the
// intersections of adjacent lines. Each side reports a confidence; a close rival edge lowers it (ambiguity).
import type { Pt, Quad, RgbaImage, SnappedQuad } from '@roofline/shared';
import { fitLine, intersect, type Gray, type Line, sample, toGray } from './gray.ts';

export type SnapResult = SnappedQuad & {
  /** One-sigma corner noise from the line fits, pixels (feeds measure's uncertainty). */
  cornerSigmaPx: [number, number, number, number];
  /** Per side: how many other strong parallel edges were in the band (0 = unambiguous). */
  rivals: [number, number, number, number];
};

type Candidate = { o0: number; o1: number; score: number; sign: 1 | -1 };
type SideScan = { a: Pt; b: Pt; n: Pt; ts: number[]; offsets: number[]; grad: Float32Array[]; band: number; candidates: Candidate[]; maxScore: number };

const T0 = 0.1;
const T1 = 0.9;

function scanSide(g: Gray, a: Pt, b: Pt, centre: Pt, band: number): SideScan | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (!(len > 10)) return null;
  // Outward normal: away from the quad's centre.
  let n: Pt = [dy / len, -dx / len];
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if ((mid[0] - centre[0]) * n[0] + (mid[1] - centre[1]) * n[1] < 0) n = [-n[0], -n[1]];
  const K = Math.max(24, Math.min(160, Math.round(len / 6)));
  const step = Math.max(0.5, band / 160);
  const M = Math.ceil(band / step);
  const offsets = Array.from({ length: 2 * M + 1 }, (_, i) => (i - M) * step);
  const ts: number[] = [];
  const grad: Float32Array[] = [];
  const tx = dx / len;
  const ty = dy / len;
  for (let k = 0; k < K; k++) {
    const t = T0 + ((T1 - T0) * k) / (K - 1);
    const p: Pt = [a[0] + dx * t, a[1] + dy * t];
    const prof = new Float32Array(offsets.length);
    let ok = true;
    for (let i = 0; i < offsets.length; i++) {
      const o = offsets[i]!;
      let v = 0;
      // Averaged over 5 px along the side (noise, texture).
      for (const s of [-2, -1, 0, 1, 2]) {
        const sv = sample(g, p[0] + n[0] * o + tx * s, p[1] + n[1] * o + ty * s);
        if (Number.isNaN(sv)) {
          ok = false;
          break;
        }
        v += sv;
      }
      if (!ok) break;
      prof[i] = v / 5;
    }
    if (!ok) continue;
    // Derivative (outward) over about 1.5 px.
    const h = Math.max(1, Math.round(0.75 / step));
    const gr = new Float32Array(offsets.length);
    for (let i = 0; i < offsets.length; i++) gr[i] = (prof[Math.min(offsets.length - 1, i + h)]! - prof[Math.max(0, i - h)]!) / (2 * h * step);
    ts.push(t);
    grad.push(gr);
  }
  if (ts.length < 8) return null;
  // Robust clip of each contribution: one glint must not make a line.
  const all: number[] = [];
  for (const gr of grad) for (let i = 0; i < gr.length; i += 3) all.push(Math.abs(gr[i]!));
  all.sort((x, y) => x - y);
  const clip = Math.max(1, all[Math.floor(all.length * 0.98)]!);
  // Score lines o(t) = o0 + (o1 - o0) (t - T0) / (T1 - T0) on a grid.
  const gstep = Math.max(1, band / 50);
  const G = Math.floor(band / gstep);
  const size = 2 * G + 1;
  const scores = new Float32Array(size * size);
  const lookup = (gr: Float32Array, o: number) => {
    const fi = o / step + M;
    const i0 = Math.floor(fi);
    if (i0 < 0 || i0 >= offsets.length - 1) return 0;
    const f = fi - i0;
    const v = gr[i0]! * (1 - f) + gr[i0 + 1]! * f;
    return Math.max(-clip, Math.min(clip, v));
  };
  for (let i0 = 0; i0 < size; i0++) {
    const o0 = (i0 - G) * gstep;
    for (let i1 = 0; i1 < size; i1++) {
      const o1 = (i1 - G) * gstep;
      let s = 0;
      for (let k = 0; k < ts.length; k++) s += lookup(grad[k]!, o0 + ((o1 - o0) * (ts[k]! - T0)) / (T1 - T0));
      scores[i0 * size + i1] = s / ts.length;
    }
  }
  // Local maxima of |score| for each polarity.
  const candidates: Candidate[] = [];
  let maxScore = 0;
  for (const sign of [1, -1] as const) {
    for (let i0 = 0; i0 < size; i0++) {
      for (let i1 = 0; i1 < size; i1++) {
        const v = sign * scores[i0 * size + i1]!;
        if (!(v > 0)) continue;
        let isMax = true;
        for (let d0 = -2; d0 <= 2 && isMax; d0++) {
          for (let d1 = -2; d1 <= 2; d1++) {
            if (d0 === 0 && d1 === 0) continue;
            const j0 = i0 + d0;
            const j1 = i1 + d1;
            if (j0 < 0 || j1 < 0 || j0 >= size || j1 >= size) continue;
            if (sign * scores[j0 * size + j1]! > v) {
              isMax = false;
              break;
            }
          }
        }
        if (!isMax) continue;
        candidates.push({ o0: (i0 - G) * gstep, o1: (i1 - G) * gstep, score: v, sign });
        maxScore = Math.max(maxScore, v);
      }
    }
  }
  const strong = candidates.filter((c) => c.score >= 0.25 * maxScore).sort((x, y) => y.score - x.score).slice(0, 12);
  return { a, b, n, ts, offsets, grad, band, candidates: strong, maxScore };
}

/** Subpixel edge points along the picked line, and the fitted line. */
function refineSide(s: SideScan, c: Candidate): { line: Line; inlierFrac: number } | null {
  const step = s.offsets[1]! - s.offsets[0]!;
  const M = (s.offsets.length - 1) / 2;
  const reach = Math.max(2, 2.5 * Math.max(1, s.band / 50));
  const pts: [number, number][] = [];
  for (let k = 0; k < s.ts.length; k++) {
    const t = s.ts[k]!;
    const gr = s.grad[k]!;
    const oc = c.o0 + ((c.o1 - c.o0) * (t - T0)) / (T1 - T0);
    const lo = Math.max(1, Math.round((oc - reach) / step + M));
    const hi = Math.min(s.offsets.length - 2, Math.round((oc + reach) / step + M));
    let best = 0;
    let bi = -1;
    for (let i = lo; i <= hi; i++) {
      const v = c.sign * gr[i]!;
      if (v > best) {
        best = v;
        bi = i;
      }
    }
    if (bi < 0 || best < 0.35 * c.score) continue;
    let l = bi;
    let h = bi;
    while (l > 0 && c.sign * gr[l - 1]! > 0.5 * best) l--;
    while (h < gr.length - 1 && c.sign * gr[h + 1]! > 0.5 * best) h++;
    let sw = 0;
    let swo = 0;
    for (let i = l; i <= h; i++) {
      const w = c.sign * gr[i]! - 0.5 * best;
      sw += w;
      swo += w * s.offsets[i]!;
    }
    const o = sw > 0 ? swo / sw : s.offsets[bi]!;
    const p: Pt = [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
    pts.push([p[0] + s.n[0] * o, p[1] + s.n[1] * o]);
  }
  if (pts.length < 6) return null;
  const line = fitLine(pts, 0.4);
  if (line === null) return null;
  return { line, inlierFrac: line.n / s.ts.length };
}

/** Rough corners (TL, TR, BR, BL, photo pixels) onto the frame's edges; sides that cannot be found stay as given. */
export function snapQuadSync(img: RgbaImage, rough: Quad, opts: { bandFrac?: number } = {}): SnapResult {
  const g = toGray(img);
  const band = Math.max(12, (opts.bandFrac ?? 0.03) * Math.max(img.width, img.height));
  const centre: Pt = [(rough[0][0] + rough[1][0] + rough[2][0] + rough[3][0]) / 4, (rough[0][1] + rough[1][1] + rough[2][1] + rough[3][1]) / 4];
  const sides = [0, 1, 2, 3].map((i) => scanSide(g, rough[i]!, rough[(i + 1) % 4]!, centre, band));
  // Pick per polarity, then the polarity whose four picks are closest and strongest.
  const pick = (s: SideScan | null, sign: 1 | -1): { c: Candidate; cost: number } | null => {
    if (s === null) return null;
    let best: { c: Candidate; cost: number } | null = null;
    for (const c of s.candidates) {
      if (c.sign !== sign || c.score < 0.3 * s.maxScore) continue;
      const d = (Math.abs(c.o0) + Math.abs(c.o1)) / 2 / s.band;
      const cost = d + 0.35 * (1 - c.score / s.maxScore);
      if (best === null || cost < best.cost) best = { c, cost };
    }
    return best;
  };
  let chosen: ({ c: Candidate; cost: number } | null)[] = [null, null, null, null];
  let bestTotal = Infinity;
  for (const sign of [1, -1] as const) {
    const picks = sides.map((s) => pick(s, sign));
    // A side with no edge of this polarity falls back to its best edge of either polarity, at a cost.
    const filled = picks.map((p, i) => p ?? (() => {
      const other = pick(sides[i]!, sign === 1 ? -1 : 1);
      return other === null ? null : { c: other.c, cost: other.cost + 0.6 };
    })());
    const total = filled.reduce((acc, p) => acc + (p === null ? 2 : p.cost), 0);
    if (total < bestTotal) {
      bestTotal = total;
      chosen = filled;
    }
  }
  const lines: (Line | null)[] = [];
  const conf: number[] = [];
  const rivals: number[] = [];
  const sigmaOff: number[] = [];
  for (let i = 0; i < 4; i++) {
    const s = sides[i]!;
    const ch = chosen[i]!;
    if (s === null || ch === null) {
      lines.push(null);
      conf.push(0);
      rivals.push(0);
      sigmaOff.push(3);
      continue;
    }
    const r = refineSide(s, ch.c);
    if (r === null || r.inlierFrac < 0.35) {
      lines.push(null);
      conf.push(0);
      rivals.push(0);
      sigmaOff.push(3);
      continue;
    }
    lines.push(r.line);
    // Rivals: other strong edges of the same polarity in the band, roughly parallel.
    const rv = s.candidates.filter((c) => c !== ch.c && c.sign === ch.c.sign && c.score >= 0.6 * ch.c.score && Math.abs(c.o0 - c.o1 - (ch.c.o0 - ch.c.o1)) < s.band * 0.3 && Math.abs((c.o0 + c.o1) / 2 - (ch.c.o0 + ch.c.o1) / 2) > 2);
    rivals.push(rv.length);
    const strength = Math.min(1, ch.c.score / 25); // grey levels per pixel
    const fitQ = Math.max(0, 1 - r.line.rms / 2) * Math.min(1, r.inlierFrac / 0.7);
    conf.push(Math.max(0, Math.min(1, strength * fitQ * (rv.length > 0 ? 0.6 : 1))));
    sigmaOff.push(Math.max(0.15, r.line.rms * Math.sqrt(4 / Math.max(r.line.n, 1))));
  }
  const quad = rough.map((p) => [...p] as Pt) as Quad;
  const sigma: [number, number, number, number] = [3, 3, 3, 3];
  // Corner k is where side k-1 (ending at it) meets side k (starting at it).
  for (let k = 0; k < 4; k++) {
    const l1 = lines[(k + 3) % 4];
    const l2 = lines[k];
    if (l1 && l2) {
      const p = intersect(l1, l2);
      if (p !== null && Math.hypot(p[0] - rough[k]![0], p[1] - rough[k]![1]) < 2.5 * band) {
        quad[k] = p;
        sigma[k] = Math.hypot(sigmaOff[(k + 3) % 4]!, sigmaOff[k]!);
      }
    } else if (l1 || l2) {
      // One side found: move the corner onto it, along its normal.
      const l = (l1 ?? l2)!;
      const d = l.nx * rough[k]![0] + l.ny * rough[k]![1] - l.c;
      quad[k] = [rough[k]![0] - d * l.nx, rough[k]![1] - d * l.ny];
    }
  }
  const moved = quad.some((p, k) => Math.hypot(p[0] - rough[k]![0], p[1] - rough[k]![1]) > 0.5);
  return { quad, sideConfidence: conf as [number, number, number, number], moved, cornerSigmaPx: sigma, rivals: rivals as [number, number, number, number] };
}

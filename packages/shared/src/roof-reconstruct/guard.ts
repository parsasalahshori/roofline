// Input guards for the reconstruction's entry: what a caller checks before handing a raster to reconstructRoof, so a
// garbled or oversized download becomes a typed reason instead of a throw, a hang or an out-of-memory. Pure.
import type { RoofRaster } from './index.ts';

/**
 * The largest raster the reconstruction is given, pixels. Google's Data Layers radius is capped at 100 m, so the
 * biggest grid it can send is 2,000 x 2,000 at 0.1 m (4 Mpx); 20% slack on each side gives 2,400 x 2,400. A raster
 * bigger than that is not one we asked for (and the planes' work grows with it).
 */
export const MAX_RASTER_PIXELS = 2400 * 2400;
/** The coarsest and finest grids accepted, metres a pixel (Google sends 0.1 for HIGH, 0.25 for MEDIUM imagery). */
export const MIN_PIXEL_SIZE_M = 0.05;
export const MAX_PIXEL_SIZE_M = 1;

/** Why a raster cannot be reconstructed. */
export const RASTER_PROBLEMS = ['bad-size', 'too-large', 'bad-pixel-size', 'size-mismatch', 'no-data', 'empty-mask', 'bad-point'] as const;
export type RasterProblem = (typeof RASTER_PROBLEMS)[number];

/**
 * What is wrong with a raster and query point, or null when the reconstruction may run on them: dimensions that are not
 * positive integers or exceed MAX_RASTER_PIXELS, a pixel size outside [MIN_PIXEL_SIZE_M, MAX_PIXEL_SIZE_M], arrays of
 * another length than width x height, no finite height under the mask, an empty mask, or a point that is not finite.
 * Never throws (a raster of the wrong shape is an answer, not an error).
 */
export function rasterProblem(raster: RoofRaster | null | undefined, point: { col: number; row: number } | null | undefined): RasterProblem | null {
  try {
    if (raster === null || raster === undefined || typeof raster !== 'object') return 'bad-size';
    const { width: W, height: H, pixelSizeM: s } = raster;
    if (!Number.isInteger(W) || !Number.isInteger(H) || W < 3 || H < 3) return 'bad-size';
    if (W * H > MAX_RASTER_PIXELS) return 'too-large';
    if (!(typeof s === 'number' && s >= MIN_PIXEL_SIZE_M && s <= MAX_PIXEL_SIZE_M)) return 'bad-pixel-size';
    const n = W * H;
    if (!(raster.dsm instanceof Float32Array) || !(raster.mask instanceof Uint8Array) || raster.dsm.length !== n || raster.mask.length !== n) return 'size-mismatch';
    if (raster.green !== undefined && raster.green !== null && (!(raster.green instanceof Uint8Array) || raster.green.length !== n)) return 'size-mismatch';
    if (point === null || point === undefined || !Number.isFinite(point.col) || !Number.isFinite(point.row)) return 'bad-point';
    let masked = 0;
    let finite = 0;
    for (let i = 0; i < n; i++) {
      if (raster.mask[i] === 0) continue;
      masked++;
      if (Number.isFinite(raster.dsm[i]!)) finite++;
    }
    if (masked === 0) return 'empty-mask';
    if (finite === 0) return 'no-data';
    return null;
  } catch {
    return 'bad-size';
  }
}

/**
 * The largest roof (Google's mask part under the point) the reconstruction is run on, square metres. The work grows
 * with the part: a 200 m square roof took 15 s and 570 MB in one synchronous run, which would stall every other
 * request. The benchmark buys houses of 900 to 6,000 sq ft (84 to 557 m2); 3,000 m2 is over five times the largest,
 * room for a big house joined to its neighbours, and still well under a second.
 */
export const MAX_ROOF_PART_M2 = 3000;

/**
 * The area of the mask part under `point` (or the nearest one within reachM, as the reconstruction looks for it),
 * square metres; 0 when there is none. Stops counting past stopM2. Assumes rasterProblem found nothing wrong.
 */
export function roofPartAreaM2(raster: RoofRaster, point: { col: number; row: number }, reachM = 12, stopM2 = MAX_ROOF_PART_M2 * 2): number {
  const { width: W, height: H, pixelSizeM: s } = raster;
  const reach = Math.ceil(reachM / s);
  const pc = Math.min(W - 1, Math.max(0, Math.floor(point.col)));
  const pr = Math.min(H - 1, Math.max(0, Math.floor(point.row)));
  let start = -1;
  let best = Infinity;
  for (let r = Math.max(0, pr - reach); r <= Math.min(H - 1, pr + reach); r++) {
    for (let c = Math.max(0, pc - reach); c <= Math.min(W - 1, pc + reach); c++) {
      if (raster.mask[r * W + c] === 0) continue;
      const d = Math.hypot(c + 0.5 - point.col, r + 0.5 - point.row);
      if (d < best) {
        best = d;
        start = r * W + c;
      }
    }
  }
  if (start < 0 || best > reach) return 0;
  const stopPx = stopM2 / (s * s);
  const seen = new Uint8Array(W * H);
  const stack = [start];
  seen[start] = 1;
  let count = 0;
  while (stack.length > 0 && count < stopPx) {
    const i = stack.pop()!;
    count++;
    const c = i % W;
    const r = (i - c) / W;
    const visit = (j: number) => {
      if (seen[j] || raster.mask[j] === 0) return;
      seen[j] = 1;
      stack.push(j);
    };
    if (c > 0) visit(i - 1);
    if (c < W - 1) visit(i + 1);
    if (r > 0) visit(i - W);
    if (r < H - 1) visit(i + W);
  }
  return count * s * s;
}

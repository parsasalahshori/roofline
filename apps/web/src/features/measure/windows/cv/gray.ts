// Grey pixels and subpixel sampling for the measuring engine (browser and Node alike; no DOM).
import type { RgbaImage } from '@roofline/shared';

export type Gray = { w: number; h: number; d: Float32Array };

const cache = new WeakMap<Uint8ClampedArray, Gray>();

/** Luma (Rec. 601) of an RGBA image, 0..255; cached per pixel buffer so detection and snapping share it. */
export function toGray(img: RgbaImage): Gray {
  const hit = cache.get(img.data);
  if (hit !== undefined && hit.w === img.width && hit.h === img.height) return hit;
  const n = img.width * img.height;
  const d = new Float32Array(n);
  const s = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) d[i] = 0.299 * s[j]! + 0.587 * s[j + 1]! + 0.114 * s[j + 2]!;
  const g = { w: img.width, h: img.height, d };
  cache.set(img.data, g);
  return g;
}

/**
 * Bilinear grey value at photo coordinates (x, y): the browser's convention, pixel (i, j) covers [i, i+1) x [j, j+1),
 * so its centre is at (i + 0.5, j + 0.5). NaN outside the image.
 */
export function sample(g: Gray, px: number, py: number): number {
  const x = px - 0.5;
  const y = py - 0.5;
  if (!(x >= 0 && y >= 0 && x <= g.w - 1 && y <= g.h - 1)) return Number.NaN;
  const x0 = Math.min(Math.floor(x), g.w - 2);
  const y0 = Math.min(Math.floor(y), g.h - 2);
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * g.w + x0;
  const d = g.d;
  const a = d[i]! + (d[i + 1]! - d[i]!) * fx;
  const b = d[i + g.w]! + (d[i + g.w + 1]! - d[i + g.w]!) * fx;
  return a + (b - a) * fy;
}

/** An RGBA image shrunk by an integer factor (box average), for the marker finder. */
export function shrinkRgba(img: RgbaImage, f: number): RgbaImage {
  if (f <= 1) return img;
  const w = Math.floor(img.width / f);
  const h = Math.floor(img.height / f);
  const out = new Uint8ClampedArray(w * h * 4);
  const s = img.data;
  const area = f * f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let gg = 0;
      let b = 0;
      for (let yy = 0; yy < f; yy++) {
        let j = ((y * f + yy) * img.width + x * f) * 4;
        for (let xx = 0; xx < f; xx++, j += 4) {
          r += s[j]!;
          gg += s[j + 1]!;
          b += s[j + 2]!;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / area;
      out[o + 1] = gg / area;
      out[o + 2] = b / area;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

export type Line = { /** unit normal */ nx: number; ny: number; /** nx*x + ny*y = c */ c: number; rms: number; n: number; spread: number };

/** Total-least-squares line through points, trimmed twice at 2.5 robust sigma (at least `minResid` px). */
export function fitLine(pts: [number, number][], minResid = 0.3): Line | null {
  let use = pts;
  let line: Line | null = null;
  for (let round = 0; round < 3; round++) {
    if (use.length < 3) return line;
    let mx = 0;
    let my = 0;
    for (const p of use) {
      mx += p[0];
      my += p[1];
    }
    mx /= use.length;
    my /= use.length;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const p of use) {
      const dx = p[0] - mx;
      const dy = p[1] - my;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    // Direction of largest spread; the normal is perpendicular.
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const dx = Math.cos(theta);
    const dy = Math.sin(theta);
    const nx = -dy;
    const ny = dx;
    const c = nx * mx + ny * my;
    const res = use.map((p) => nx * p[0] + ny * p[1] - c);
    const rms = Math.sqrt(res.reduce((a, r) => a + r * r, 0) / res.length);
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of use) {
      const t = dx * p[0] + dy * p[1];
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    line = { nx, ny, c, rms, n: use.length, spread: hi - lo };
    const abs = res.map(Math.abs).sort((a, b) => a - b);
    const sigma = 1.4826 * abs[Math.floor(abs.length / 2)]!;
    const limit = Math.max(2.5 * sigma, minResid);
    const next = use.filter((_, i) => Math.abs(res[i]!) <= limit);
    if (next.length === use.length) break;
    use = next;
  }
  return line;
}

export function intersect(a: Line, b: Line): [number, number] | null {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-9) return null;
  return [(a.c * b.ny - a.ny * b.c) / det, (a.nx * b.c - a.c * b.nx) / det];
}

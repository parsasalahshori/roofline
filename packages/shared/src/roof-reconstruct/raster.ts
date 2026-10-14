// Raster helpers for the roof reconstruction: binary masks on a W x H grid (row-major, 1 = set), exact Euclidean
// distance transforms, morphology, 4-connected labelling, hole filling and a small binary heap. Pure and synchronous.

export type Grid = { w: number; h: number };
export type Mask = Uint8Array;

const INF = 1e20;

/** A seeded random number generator (mulberry32): the same seed gives the same roof every time. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 1-D squared distance transform (Felzenszwalb and Huttenlocher) of f into d, using scratch v and z. */
function dt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const dq = q - v[k]!;
    d[q] = dq * dq + f[v[k]!]!;
  }
}

/**
 * Squared Euclidean distance (pixels) from every pixel to the nearest pixel where `set(i)` is true. Pixels outside
 * the grid count as set when `outsideSet` (so erosion treats the border as background) .
 */
export function squaredDistance(g: Grid, set: (i: number) => boolean, outsideSet = false): Float64Array {
  const { w, h } = g;
  // With the outside set, the grid is padded by one pixel all round.
  const pad = outsideSet ? 1 : 0;
  const W = w + 2 * pad;
  const H = h + 2 * pad;
  const out = new Float64Array(W * H);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const rr = r - pad;
      const cc = c - pad;
      const inside = rr >= 0 && cc >= 0 && rr < h && cc < w;
      out[r * W + c] = (inside ? set(rr * w + cc) : outsideSet) ? 0 : INF;
    }
  }
  const n = Math.max(W, H);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let c = 0; c < W; c++) {
    for (let r = 0; r < H; r++) f[r] = out[r * W + c]!;
    dt1(f, H, d, v, z);
    for (let r = 0; r < H; r++) out[r * W + c] = d[r]!;
  }
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) f[c] = out[r * W + c]!;
    dt1(f, W, d, v, z);
    for (let c = 0; c < W; c++) out[r * W + c] = d[c]!;
  }
  if (pad === 0) return out;
  const cropped = new Float64Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) cropped[r * w + c] = out[(r + pad) * W + c + pad]!;
  return cropped;
}

/** Pixels within `r` pixels (Euclidean) of the mask. */
export function dilate(g: Grid, m: Mask, r: number): Mask {
  if (r <= 0) return m.slice();
  const d = squaredDistance(g, (i) => m[i] === 1);
  const out = new Uint8Array(m.length);
  const r2 = r * r;
  for (let i = 0; i < m.length; i++) out[i] = d[i]! <= r2 ? 1 : 0;
  return out;
}

/** Mask pixels farther than `r` pixels from any background pixel (the outside of the grid is background). */
export function erode(g: Grid, m: Mask, r: number): Mask {
  if (r <= 0) return m.slice();
  const d = squaredDistance(g, (i) => m[i] !== 1, true);
  const out = new Uint8Array(m.length);
  const r2 = r * r;
  for (let i = 0; i < m.length; i++) out[i] = m[i] === 1 && d[i]! > r2 ? 1 : 0;
  return out;
}

export function open(g: Grid, m: Mask, r: number): Mask {
  return dilate(g, erode(g, m, r), r);
}

export function close(g: Grid, m: Mask, r: number): Mask {
  return erode(g, dilate(g, m, r), r);
}

/** 3 x 3 erosion then dilation: removes one-pixel spurs and specks, cheaply. */
export function open3(g: Grid, m: Mask): Mask {
  const { w, h } = g;
  const e = new Uint8Array(m.length);
  for (let r = 1; r < h - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      const i = r * w + c;
      if (m[i] !== 1) continue;
      let all = true;
      for (let dr = -1; dr <= 1 && all; dr++) for (let dc = -1; dc <= 1; dc++) if (m[i + dr * w + dc] !== 1) { all = false; break; }
      if (all) e[i] = 1;
    }
  }
  const out = new Uint8Array(m.length);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (m[i] !== 1) continue;
      let any = false;
      for (let dr = -1; dr <= 1 && !any; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= h) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc >= 0 && cc < w && e[rr * w + cc] === 1) { any = true; break; }
        }
      }
      if (any) out[i] = 1;
    }
  }
  return out;
}

/**
 * 4-connected components of the pixels where `inside(i)`: labels (0 = none, 1..n) and each component's size.
 */
export function components(g: Grid, inside: (i: number) => boolean): { labels: Int32Array; sizes: number[] } {
  const { w, h } = g;
  const labels = new Int32Array(w * h);
  const sizes: number[] = [0];
  const queue = new Int32Array(w * h);
  let next = 0;
  for (let s = 0; s < w * h; s++) {
    if (labels[s] !== 0 || !inside(s)) continue;
    next++;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    labels[s] = next;
    while (head < tail) {
      const p = queue[head++]!;
      const c = p % w;
      const r = (p - c) / w;
      if (c > 0 && labels[p - 1] === 0 && inside(p - 1)) { labels[p - 1] = next; queue[tail++] = p - 1; }
      if (c < w - 1 && labels[p + 1] === 0 && inside(p + 1)) { labels[p + 1] = next; queue[tail++] = p + 1; }
      if (r > 0 && labels[p - w] === 0 && inside(p - w)) { labels[p - w] = next; queue[tail++] = p - w; }
      if (r < h - 1 && labels[p + w] === 0 && inside(p + w)) { labels[p + w] = next; queue[tail++] = p + w; }
    }
    sizes.push(tail);
  }
  return { labels, sizes };
}

/** The largest 4-connected component of a mask (all zero when the mask is empty). */
export function largestComponent(g: Grid, m: Mask): Mask {
  const { labels, sizes } = components(g, (i) => m[i] === 1);
  let best = 0;
  for (let k = 1; k < sizes.length; k++) if (sizes[k]! > (sizes[best] ?? 0)) best = k;
  const out = new Uint8Array(m.length);
  if (best === 0) return out;
  for (let i = 0; i < m.length; i++) if (labels[i] === best) out[i] = 1;
  return out;
}

/** The mask with its holes (background the grid's border cannot reach) filled. */
export function fillHoles(g: Grid, m: Mask): Mask {
  const { w, h } = g;
  const outside = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let tail = 0;
  const push = (i: number) => {
    if (outside[i] === 0 && m[i] !== 1) {
      outside[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let c = 0; c < w; c++) { push(c); push((h - 1) * w + c); }
  for (let r = 0; r < h; r++) { push(r * w); push(r * w + w - 1); }
  let head = 0;
  while (head < tail) {
    const p = queue[head++]!;
    const c = p % w;
    const r = (p - c) / w;
    if (c > 0) push(p - 1);
    if (c < w - 1) push(p + 1);
    if (r > 0) push(p - w);
    if (r < h - 1) push(p + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = outside[i] === 1 ? 0 : 1;
  return out;
}

export function countSet(m: Mask): number {
  let n = 0;
  for (let i = 0; i < m.length; i++) n += m[i]!;
  return n;
}

/** A binary min-heap of (key, value) pairs; equal keys come out in insertion order (a sequence number breaks ties). */
export class MinHeap {
  private keys: Float64Array;
  private seqs: Float64Array;
  private vals: Int32Array;
  private extra: Int32Array;
  private n = 0;
  private seq = 0;
  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.seqs = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
    this.extra = new Int32Array(capacity);
  }
  get size(): number {
    return this.n;
  }
  private less(a: number, b: number): boolean {
    return this.keys[a]! < this.keys[b]! || (this.keys[a] === this.keys[b] && this.seqs[a]! < this.seqs[b]!);
  }
  private swap(a: number, b: number): void {
    const k = this.keys[a]!; this.keys[a] = this.keys[b]!; this.keys[b] = k;
    const s = this.seqs[a]!; this.seqs[a] = this.seqs[b]!; this.seqs[b] = s;
    const v = this.vals[a]!; this.vals[a] = this.vals[b]!; this.vals[b] = v;
    const e = this.extra[a]!; this.extra[a] = this.extra[b]!; this.extra[b] = e;
  }
  push(key: number, value: number, extra: number): void {
    if (this.n === this.keys.length) {
      const grow = <T extends Float64Array | Int32Array>(a: T): T => {
        const b = new (a.constructor as new (n: number) => T)(a.length * 2);
        b.set(a);
        return b;
      };
      this.keys = grow(this.keys);
      this.seqs = grow(this.seqs);
      this.vals = grow(this.vals);
      this.extra = grow(this.extra);
    }
    let i = this.n++;
    this.keys[i] = key;
    this.seqs[i] = this.seq++;
    this.vals[i] = value;
    this.extra[i] = extra;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  /** Removes the smallest pair; returns [value, extra] (call only when size > 0). */
  pop(): [number, number] {
    const out: [number, number] = [this.vals[0]!, this.extra[0]!];
    this.n--;
    if (this.n > 0) {
      this.keys[0] = this.keys[this.n]!;
      this.seqs[0] = this.seqs[this.n]!;
      this.vals[0] = this.vals[this.n]!;
      this.extra[0] = this.extra[this.n]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.n && this.less(l, m)) m = l;
        if (r < this.n && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return out;
  }
}

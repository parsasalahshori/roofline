// The crack lattice of a label image: the grid lines between pixels. Vertex (i, j) is the corner between pixel rows
// i - 1 and i and columns j - 1 and j, at x = j * s, y = -i * s. A crack is the side two pixels share (or a pixel and
// the outside); it is a boundary when their labels differ. Boundaries are traced with the label on the left, so a
// region's outer boundary runs counter-clockwise (x east, y north) and its holes clockwise. Ties at a corner where a
// label touches itself diagonally are broken for 4-connected regions.
import type { Grid } from './raster.ts';

/** Directions: 0 east, 1 north, 2 west, 3 south. */
export type Dir = 0 | 1 | 2 | 3;

export type Lattice = {
  g: Grid;
  labels: Int32Array;
  /** Vertex index: i * (w + 1) + j. */
  vw: number;
  /** Number of horizontal cracks ((h + 1) * w); vertical crack ids follow them. */
  hCount: number;
  crackCount: number;
};

export function lattice(g: Grid, labels: Int32Array): Lattice {
  const hCount = (g.h + 1) * g.w;
  return { g, labels, vw: g.w + 1, hCount, crackCount: hCount + g.h * (g.w + 1) };
}

export function pix(L: Lattice, r: number, c: number): number {
  return r < 0 || c < 0 || r >= L.g.h || c >= L.g.w ? -1 : L.labels[r * L.g.w + c]!;
}

/** The crack leaving vertex (i, j) in direction d, as a directed code (crack id * 2, plus 1 when against its id's sense). */
export function crackCode(L: Lattice, i: number, j: number, d: Dir): number {
  switch (d) {
    case 0:
      return (i * L.g.w + j) * 2;
    case 2:
      return (i * L.g.w + j - 1) * 2 + 1;
    case 3:
      return (L.hCount + i * (L.g.w + 1) + j) * 2;
    default:
      return (L.hCount + (i - 1) * (L.g.w + 1) + j) * 2 + 1;
  }
}

/** The labels left and right of the crack leaving (i, j) in direction d. */
export function sides(L: Lattice, i: number, j: number, d: Dir): [number, number] {
  switch (d) {
    case 0:
      return [pix(L, i - 1, j), pix(L, i, j)];
    case 2:
      return [pix(L, i, j - 1), pix(L, i - 1, j - 1)];
    case 3:
      return [pix(L, i, j), pix(L, i, j - 1)];
    default:
      return [pix(L, i - 1, j - 1), pix(L, i - 1, j)];
  }
}

export function step(i: number, j: number, d: Dir): [number, number] {
  return d === 0 ? [i, j + 1] : d === 1 ? [i - 1, j] : d === 2 ? [i, j - 1] : [i + 1, j];
}

/** Arriving at (i, j) moving `d` with label f on the left: the direction that keeps f on the left. */
function turn(L: Lattice, i: number, j: number, d: Dir, f: number): Dir {
  const nw = pix(L, i - 1, j - 1);
  const ne = pix(L, i - 1, j);
  const sw = pix(L, i, j - 1);
  const se = pix(L, i, j);
  switch (d) {
    case 0:
      return ne !== f ? 1 : se !== f ? 0 : 3;
    case 1:
      return nw !== f ? 2 : ne !== f ? 1 : 0;
    case 2:
      return sw !== f ? 3 : nw !== f ? 2 : 1;
    default:
      return se !== f ? 0 : sw !== f ? 3 : 2;
  }
}

/** One boundary cycle: its vertices in order and, for each, the directed crack leaving it. */
export type Cycle = { verts: number[]; codes: number[] };

/** Every boundary cycle of label f (f on the left), outer boundaries and holes alike. */
export function traceCycles(L: Lattice, f: number, visited: Uint8Array = new Uint8Array(L.crackCount * 2)): Cycle[] {
  const { g, vw } = L;
  const out: Cycle[] = [];
  const startAt = (i0: number, j0: number, d0: Dir) => {
    const first = crackCode(L, i0, j0, d0);
    if (visited[first] === 1) return;
    const verts: number[] = [];
    const codes: number[] = [];
    let i = i0;
    let j = j0;
    let d: Dir = d0;
    for (let guard = 0; guard < 4 * L.crackCount; guard++) {
      const code = crackCode(L, i, j, d);
      if (guard > 0 && code === first) break;
      visited[code] = 1;
      verts.push(i * vw + j);
      codes.push(code);
      [i, j] = step(i, j, d);
      d = turn(L, i, j, d, f);
    }
    out.push({ verts, codes });
  };
  // Every horizontal crack with f on one side starts (or is part of) a cycle; every cycle has one.
  for (let i = 0; i <= g.h; i++) {
    for (let j = 0; j < g.w; j++) {
      const north = pix(L, i - 1, j);
      const south = pix(L, i, j);
      if (north === south) continue;
      if (north === f) startAt(i, j, 0);
      else if (south === f) startAt(i, j + 1, 2);
    }
  }
  return out;
}

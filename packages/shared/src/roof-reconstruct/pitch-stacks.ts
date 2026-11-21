// The chord of a bowed slope as its faces' pitch reading (docs/roof-3d/pitch-steep.md).
//
// A height map bows some slopes: steep by the crest, shallow by the eave, sagging under the true plane between them.
// The plane search cuts such a slope into an upper, steeper face over a lower, shallower one, and neither plane is the
// roof's: on the benchmark the pair read 8.0 and 5.2 on a 6/12 slope. The slope's ends are where they should be, so
// its pitch is its rise over its run from crest to eave (the chord), whatever the heights do between.
//
// primitives.ts already tells such a pair by structure (mergeStacks: the upper face over the lower one, no wall
// between, a crest above and the roof's edge below, both under the chord within the sag, the chord at the roof's own
// pitch and the upper strip steeper than it) and can merge the two faces on the chord plane. That merge is off (it
// redraws faces and lines, and line totals were no better for it). Here the same test is run on the finished faces and
// only its pitch is taken: the two faces stay as they are, with their lines, and each reads the chord's pitch.
import type { Grid, Mask } from './raster.ts';
import type { Faces, Plane } from './planes.ts';
import { type FittedKind, mergeStacks, type PrimitiveParams } from './primitives.ts';

/**
 * Per face (the order of `planes`): the pitch (x/12) of the chord plane of the stack it is part of, or null when it is
 * in no stack. `planes` are the faces' planes as reported; `locked` (not changed) the planes fitted by a primitive.
 * A face that is level on its own plane (under flatX12) keeps its reading: it is reported flat.
 */
export function stackChords(
  g: Grid,
  s: number,
  dsm: Float32Array,
  roof: Mask,
  faces: Faces,
  planes: readonly Plane[],
  locked: ReadonlyMap<Plane, FittedKind>,
  prm: PrimitiveParams,
  flatX12: number,
  debug?: (msg: string) => void,
): (number | null)[] {
  const n = planes.length;
  const out = new Array<number | null>(n).fill(null);
  if (n < 2) return out;
  const fitted = new Map(locked);
  const done = mergeStacks(g, s, dsm, roof, faces, planes, fitted, { ...prm, enabled: true, stacks: true });
  if (done.merged.length === 0) return out;
  // Each face's pixels by the face they are in after the merge: a face is in a stack when most of them lie in a face
  // on a chord plane.
  const m = done.faces.planes.length;
  const tally = new Int32Array(n * m);
  const size = new Int32Array(n);
  for (let i = 0; i < faces.labels.length; i++) {
    const k = faces.labels[i]!;
    const j = done.faces.labels[i]!;
    if (k < 0) continue;
    size[k]!++;
    if (j >= 0) tally[k * m + j]!++;
  }
  for (let k = 0; k < n; k++) {
    let best = -1;
    for (let j = 0; j < m; j++) if (tally[k * m + j]! > (best < 0 ? 0 : tally[k * m + best]!)) best = j;
    if (best < 0 || 2 * tally[k * m + best]! <= size[k]!) continue;
    const chord = done.faces.planes[best]!;
    if (fitted.get(chord) !== 'stack' || locked.has(chord)) continue;
    const own = Math.hypot(planes[k]!.a, planes[k]!.b) * 12;
    if (own < flatX12) continue;
    out[k] = Math.hypot(chord.a, chord.b) * 12;
    debug?.(`pitch: face ${k} (${own.toFixed(1)}/12) is a strip of a bowed slope: reads its chord, ${out[k]!.toFixed(1)}/12`);
  }
  return out;
}

// Golden synthetic roofs at the pixel sizes Google's Data Layers come in: 0.1 m (HIGH) and 0.25-0.3 m (MEDIUM), axis
// aligned and turned, clean and noisy. A clean, axis-aligned face is the hard case for a deterministic plane search:
// every candidate on it fits every point, so the search must not depend on which tied candidate it looks at first.
import { describe, expect, it } from 'vitest';
import { type LocalRoof, reconstructRoof } from '../src/roof-reconstruct/index.ts';
import { gableShape, hipShape, type Shape, synthesize, type XY } from './fixtures/synthetic-roofs.ts';

function inside(p: XY, ring: readonly XY[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

function lengthOf(roof: LocalRoof, kind: string): number {
  return roof.lines.filter((l) => l.kind === kind).reduce((t, l) => t + l.lengthM, 0);
}

/**
 * Area tolerance: 1% at 0.1 m; at coarser pixels the outline can only be placed to about half a pixel, so the tolerance
 * grows with the pixel (2% at 0.25-0.3 m on these 100-200 m2 roofs).
 */
const areaTol = (px: number) => (px <= 0.1 ? 0.01 : 0.02);

describe('plane search at HIGH and MEDIUM pixel sizes (golden synthetic roofs)', () => {
  const cases: { shape: Shape; ridgeKinds: string[] }[] = [
    { shape: gableShape(14, 9, 4), ridgeKinds: ['ridge'] },
    { shape: gableShape(16, 10, 8), ridgeKinds: ['ridge'] },
    { shape: gableShape(16, 10, 10), ridgeKinds: ['ridge'] },
    { shape: gableShape(12, 8, 4), ridgeKinds: ['ridge'] },
    { shape: hipShape(16, 10, 5), ridgeKinds: ['ridge', 'hip'] },
    { shape: hipShape(16, 10, 8), ridgeKinds: ['ridge', 'hip'] },
    { shape: hipShape(14, 9, 6), ridgeKinds: ['ridge', 'hip'] },
  ];
  for (const px of [0.1, 0.25, 0.3]) {
    for (const turnDeg of [0, 15, 30]) {
      for (const noiseM of [0, 0.03]) {
        it(`${px} m pixels, turned ${turnDeg} deg, noise ${noiseM} m: every face, pitch, area and ridge/hip`, () => {
          for (const { shape, ridgeKinds } of cases) {
            const syn = synthesize(shape, { turnDeg, pixelM: px, noiseM, trees: 0, seed: 5 });
            const r = reconstructRoof(syn.raster, syn.point, { seed: 7 });
            const tag = `${shape.name} @${px} m t${turnDeg} n${noiseM}`;
            expect(r, tag).not.toBeNull();
            expect(r!.faces.length, `${tag}: faces`).toBe(syn.faces.length);
            for (const truth of syn.faces) {
              const face = r!.faces.find((f) => inside(syn.toLocal(truth.probe), f.ring));
              expect(face, `${tag}: ${truth.name}`).toBeDefined();
              expect(Math.abs(face!.pitchX12 - truth.pitchX12), `${tag}: ${truth.name} pitch`).toBeLessThan(0.5);
            }
            const area = r!.faces.reduce((t, f) => t + f.planAreaM2, 0);
            expect(Math.abs(area / syn.planAreaM2 - 1), `${tag}: area`).toBeLessThan(areaTol(px));
            for (const kind of ridgeKinds) {
              const want = syn.lines[kind as keyof typeof syn.lines]!;
              // A line is placed to about a pixel at each end.
              expect(Math.abs(lengthOf(r!, kind) - want), `${tag}: ${kind}`).toBeLessThan(Math.max(0.05 * want, 4 * px * (kind === 'hip' ? 4 : 1)));
            }
          }
        });
      }
    }
  }
});

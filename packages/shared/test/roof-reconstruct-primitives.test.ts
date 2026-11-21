// Roof primitives (primitives.ts): a gable's bowed slope fitted from its ridge, its eave and the slope across the
// ridge; stacked strips of one bowed slope merged on the plane through its crest and its eave. Real pitch breaks,
// porch roofs under a wall, dormers and clean roofs stay as the plane search drew them.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIMITIVE_PARAMS, type LocalRoof, reconstructRoof } from '../src/roof-reconstruct/index.ts';
import { DORMER_GABLE } from './fixtures/hard-roofs.ts';
import { BOWED_GABLE, BOWED_HIP, BOWED_L, bowedRise, PITCH_BREAK, PORCH, SHAPES, synthesize, type Shape, type XY } from './fixtures/synthetic-roofs.ts';

// Both fits on (the stack merge is off by default), and both off.
const ON = { primitives: { enabled: true, gables: true, stacks: true } } as const;
const OFF = { primitives: { enabled: false } } as const;

function lengths(roof: LocalRoof): Record<string, number> {
  const by: Record<string, number> = {};
  for (const l of roof.lines) by[l.kind] = (by[l.kind] ?? 0) + l.lengthM;
  return by;
}

function inside(p: XY, ring: readonly XY[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

function arc(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** The reconstruction of a shape with the primitives on and off. */
function both(shape: Shape, o: Parameters<typeof synthesize>[1] = {}) {
  const syn = synthesize(shape, { trees: 0, ...o });
  const on = reconstructRoof(syn.raster, syn.point, ON);
  const off = reconstructRoof(syn.raster, syn.point, OFF);
  expect(on, shape.name).not.toBeNull();
  expect(off, shape.name).not.toBeNull();
  return { syn, on: on!, off: off! };
}

/** Each true face found once, at its pitch (within `pitchTol`/12) and plan area (within 6 %); each line total within 6 %. */
function expectTruth(syn: ReturnType<typeof synthesize>, roof: LocalRoof, pitchTol = 0.6): void {
  expect(roof.faces.length, `${syn.name}: face count`).toBe(syn.faces.length);
  for (const truth of syn.faces) {
    const face = roof.faces.find((f) => inside(syn.toLocal(truth.probe), f.ring));
    expect(face, `${syn.name}: ${truth.name} found`).toBeDefined();
    expect(Math.abs(face!.pitchX12 - truth.pitchX12), `${syn.name}: ${truth.name} pitch ${face!.pitchX12}`).toBeLessThan(pitchTol);
    expect(Math.abs(face!.planAreaM2 / truth.planAreaM2 - 1), `${syn.name}: ${truth.name} area`).toBeLessThan(0.06);
  }
  const got = lengths(roof);
  for (const [kind, want] of Object.entries(syn.lines)) expect(Math.abs((got[kind] ?? 0) / want - 1), `${syn.name}: ${kind} length ${got[kind]} vs ${want}`).toBeLessThan(0.06);
  for (const [kind, len] of Object.entries(got)) if (!(kind in syn.lines)) expect(len, `${syn.name}: no ${kind}`).toBeLessThan(0.5);
}

describe('roof primitives: a bowed slope is one face', () => {
  it('the bow is what the fixture says: the true plane at ridge and eave, under it between', () => {
    expect(bowedRise(0, 4.5, 6)).toBe(0);
    expect(bowedRise(4.5, 4.5, 6)).toBeCloseTo(2.25, 9);
    expect(bowedRise(2.9, 4.5, 6)).toBeLessThan(0.5 * 2.9 - 0.4);
  });

  it('a gable with a bowed slope: without the fit, strips and an eave across the slope; with it, two faces', () => {
    for (const turnDeg of [17, 63]) {
      const { syn, on, off } = both(BOWED_GABLE, { turnDeg });
      // Off: the bowed slope is cut along a level line and the upper strip's "eave" is drawn across it.
      expect(off.faces.length, `turn ${turnDeg}: faces without the fit`).toBeGreaterThan(2);
      expect(lengths(off).eave!, `turn ${turnDeg}: eave without the fit`).toBeGreaterThan(28 + 10);
      expectTruth(syn, on);
      expect(on.gables, `turn ${turnDeg}`).toHaveLength(1);
      expect(on.gables![0]!.absorbed).toBeGreaterThanOrEqual(2);
    }
  });

  it('an L-shaped cross gable with two bowed slopes and a level pocket: five faces, two ridges, two valleys', () => {
    const { syn, on, off } = both(BOWED_L);
    expect(off.faces.length).toBeGreaterThan(syn.faces.length + 1);
    expectTruth(syn, on);
    expect(on.gables!.length).toBeGreaterThanOrEqual(2);
  });

  it('a hip roof with a bowed side (its lower strip runs on past the ridge under the hips): the stacked strips become one face', () => {
    const { syn, on, off } = both(BOWED_HIP);
    expect(off.faces.length).toBeGreaterThan(4);
    expectTruth(syn, on);
    expect(on.stacks).toHaveLength(1);
    expect(on.stacks![0]!.upperX12).toBeGreaterThan(on.stacks![0]!.pitchX12 + 1);
  });

  it('a dormer on the bowed slope stands above it and stays', () => {
    const bowed: Shape = {
      ...DORMER_GABLE,
      name: 'gable with a dormer on its bowed slope',
      height: (p) => {
        const h = DORMER_GABLE.height(p);
        if (h === null || p.y >= 0) return h;
        const dormer = Math.abs(p.x) <= 1.6 ? 3 + 0.5 + (1.6 - Math.abs(p.x)) * (8 / 12) : -Infinity;
        return Math.max(3 + bowedRise(5 + p.y, 5, 6), dormer);
      },
    };
    const { syn, on } = both(bowed);
    expect(on.gables).toHaveLength(1);
    // The dormer's two faces: across the main slope, not along it, and steep.
    for (const name of ['dormer east', 'dormer west']) {
      const truth = syn.faces.find((f) => f.name === name)!;
      const face = on.faces.find((f) => arc(f.azimuthDeg, syn.azimuth(truth.downDeg)) < 25 && f.pitchX12 > 5 && f.planAreaM2 < 10);
      expect(face, name).toBeDefined();
    }
    expect(on.faces.length).toBe(4);
    const south = on.faces.find((f) => inside(syn.toLocal({ x: 5, y: -2.5 }), f.ring))!;
    expect(Math.abs(south.pitchX12 - 6)).toBeLessThan(0.6);
    expect(lengths(on).valley ?? 0).toBeGreaterThan(2);
  });
});

describe('roof primitives: what is not a bowed slope is left alone', () => {
  it('clean roofs come out the same with the primitives on', () => {
    for (const shape of [...SHAPES, PORCH, DORMER_GABLE]) {
      const { on, off } = both(shape);
      expect(on, shape.name).toEqual(off);
    }
  });

  it('a real pitch break (a gable running on into a porch roof, no step) keeps its three faces', () => {
    const { syn, on, off } = both(PITCH_BREAK);
    expect(on).toEqual(off);
    expect(on.faces.length).toBe(3);
    for (const truth of syn.faces) {
      const face = on.faces.find((f) => inside(syn.toLocal(truth.probe), f.ring));
      expect(face, truth.name).toBeDefined();
      expect(Math.abs(face!.pitchX12 - truth.pitchX12), `${truth.name} pitch`).toBeLessThan(0.5);
    }
  });

  it('is deterministic and switchable piece by piece', () => {
    const syn = synthesize(BOWED_L, { trees: 0 });
    const a = reconstructRoof(syn.raster, syn.point, ON);
    const b = reconstructRoof(syn.raster, syn.point, ON);
    expect(a).toEqual(b);
    const noGables = reconstructRoof(syn.raster, syn.point, { primitives: { enabled: true, gables: false, stacks: false } })!;
    expect(noGables.gables).toBeUndefined();
    const hip = synthesize(BOWED_HIP, { trees: 0 });
    const noStacks = reconstructRoof(hip.raster, hip.point, { primitives: { enabled: true, stacks: false } })!;
    expect(noStacks.stacks).toBeUndefined();
    expect(noStacks.faces.length).toBeGreaterThan(4);
    // As shipped: the gable fit on, the stack merge off.
    expect(DEFAULT_PRIMITIVE_PARAMS).toMatchObject({ enabled: true, gables: true, stacks: false });
    expect(reconstructRoof(hip.raster, hip.point)).toEqual(noStacks);
    const gable = synthesize(BOWED_GABLE, { trees: 0 });
    expect(reconstructRoof(gable.raster, gable.point)!.gables).toHaveLength(1);
  });
});

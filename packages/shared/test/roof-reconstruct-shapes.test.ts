// Fitted shapes (fitted-shapes.ts): small roofs a height map blurs into their neighbours, fitted as shapes where the
// plane search finds no plane: a hip end merged into the two long slopes (hip-ends.ts), a small roof with a ridge of
// its own (ridge-roofs.ts). And what must stay as it is: a plain gable, a clean hip roof, a slope fitted as a gable.
import { describe, expect, it } from 'vitest';
import { type LocalRoof, reconstructRoof } from '../src/roof-reconstruct/index.ts';
import { judgeShape } from '../src/roof-reconstruct/fitted-shapes.ts';
import { roofDirections } from '../src/roof-reconstruct/ridge-roofs.ts';
import { hipWithGableBump, NARROW_HIP, soften } from './fixtures/small-shapes.ts';
import { BOWED_GABLE, GABLE, HIP, L_CROSS, type Shape, synthesize, type SyntheticRoof, type XY } from './fixtures/synthetic-roofs.ts';

const ON = { primitives: { ridgeRoofs: true, hipEnds: true } } as const;
const OFF = { primitives: { ridgeRoofs: false, hipEnds: false } } as const;

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

function both(syn: SyntheticRoof): { on: LocalRoof; off: LocalRoof } {
  const on = reconstructRoof(syn.raster, syn.point, ON);
  const off = reconstructRoof(syn.raster, syn.point, OFF);
  expect(on, syn.name).not.toBeNull();
  expect(off, syn.name).not.toBeNull();
  return { on: on!, off: off! };
}

/** The face holding a house-frame point, with its facing checked against the truth's. */
function faceAt(syn: SyntheticRoof, roof: LocalRoof, probe: XY, downDeg: number): LocalRoof['faces'][number] | undefined {
  const face = roof.faces.find((f) => inside(syn.toLocal(probe), f.ring));
  return face !== undefined && arc(face.azimuthDeg, syn.azimuth(downDeg)) <= 20 ? face : undefined;
}

describe('fitted shapes: a hip end the height map blurred away', () => {
  // A hip roof 15 x 5 m: its end faces are triangles 5 m wide. Softened, the plane search gives them to the two long
  // slopes and the roof reads as a gable: no hip at all, the ridge run out to both ends.
  for (const turnDeg of [0, 17]) {
    it(`both end faces are back, with their hips (turned ${turnDeg})`, () => {
      const syn = soften(synthesize(NARROW_HIP, { trees: 0, turnDeg }), 0.7);
      const { on, off } = both(syn);
      const was = lengths(off);
      expect(was.hip ?? 0, 'without the fit: no hips').toBeLessThan(2);
      expect(was.ridge!, 'without the fit: the ridge runs the whole length').toBeGreaterThan(14);
      const got = lengths(on);
      expect(Math.abs(got.hip! / NARROW_HIP.lines.hip! - 1), `hips ${got.hip}`).toBeLessThan(0.15);
      expect(Math.abs(got.ridge! - NARROW_HIP.lines.ridge!), `ridge ${got.ridge}`).toBeLessThan(1.6);
      expect(Math.abs(got.eave! / NARROW_HIP.lines.eave! - 1), `eaves ${got.eave}`).toBeLessThan(0.05);
      expect(got.rake ?? 0, 'no rake on a hip roof').toBeLessThan(0.5);
      expect(on.faces.length).toBe(4);
      for (const end of [NARROW_HIP.faces[2]!, NARROW_HIP.faces[3]!]) {
        const face = faceAt(syn, on, end.probe, end.downDeg);
        expect(face, `${end.name} end face`).toBeDefined();
        expect(face!.fitted).toBe('hip-end');
        expect(Math.abs(face!.planAreaM2 / end.planAreaM2 - 1), `${end.name} area ${face!.planAreaM2}`).toBeLessThan(0.3);
      }
      expect(on.shapes?.map((x) => x.kind)).toEqual(['hip-end', 'hip-end']);
      // The long slopes are the plane search's own.
      for (const long of [NARROW_HIP.faces[0]!, NARROW_HIP.faces[1]!]) expect(faceAt(syn, on, long.probe, long.downDeg)?.fitted).toBeUndefined();
    });
  }

  it('hipEnds off: the roof stays as the plane search drew it', () => {
    const syn = soften(synthesize(NARROW_HIP, { trees: 0, turnDeg: 0 }), 0.7);
    const only = reconstructRoof(syn.raster, syn.point, { primitives: { ridgeRoofs: true, hipEnds: false } })!;
    expect(only.shapes).toBeUndefined();
    expect(lengths(only).hip ?? 0).toBeLessThan(2);
  });
});

describe('fitted shapes: a gable over a bump-out, one slope lost', () => {
  // A hip roof with a gable over a bump-out on its south side, steeper than the roof. On soft, lumpy heights the plane
  // search keeps one of the gable's two slopes and gives the other to the main slope: half the gable's ridge and one
  // of its valleys are gone.
  const cases: [Shape & { bump: { half: number; depth: number } }, number][] = [
    [hipWithGableBump(2.5, 2, 12), 17],
    [hipWithGableBump(2.2, 1.5, 12), 0],
  ];
  for (const [shape, turnDeg] of cases) {
    it(`the ridge roof is whole again: ${shape.name} (turned ${turnDeg})`, () => {
      const syn = soften(synthesize(shape, { trees: 0, turnDeg }), 0.4, 2, 0.12);
      const { on, off } = both(syn);
      const was = lengths(off);
      expect(was.valley!, `without the fit: one valley of two (${was.valley})`).toBeLessThan(0.6 * shape.lines.valley!);
      expect(was.ridge!, `without the fit: the gable's ridge is missing (${was.ridge})`).toBeLessThan(shape.lines.ridge! - 3);
      const got = lengths(on);
      expect(Math.abs(got.valley! / shape.lines.valley! - 1), `valleys ${got.valley}`).toBeLessThan(0.08);
      expect(Math.abs(got.ridge! / shape.lines.ridge! - 1), `ridge ${got.ridge}`).toBeLessThan(0.05);
      expect(Math.abs(got.rake! / shape.lines.rake! - 1), `rakes ${got.rake}`).toBeLessThan(0.08);
      expect(Math.abs(got.hip! / (4 * Math.hypot(5 * Math.SQRT2, 2.5)) - 1), `the main roof's hips ${got.hip}`).toBeLessThan(0.05);
      expect(on.faces.length).toBe(6);
      expect(on.shapes?.map((x) => x.kind)).toEqual(['ridge-roof']);
      // Both slopes of the gable are there, facing away from each other; one is the plane search's own, one fitted.
      const east = faceAt(syn, on, shape.faces[3]!.probe, 0);
      const west = faceAt(syn, on, shape.faces[4]!.probe, 180);
      expect(east, 'east slope').toBeDefined();
      expect(west, 'west slope').toBeDefined();
      expect([east!.fitted, west!.fitted].filter((k) => k === 'ridge-roof').length).toBe(1);
      for (const f of [east!, west!]) expect(Math.abs(f.planAreaM2 / shape.faces[3]!.planAreaM2 - 1), `slope area ${f.planAreaM2}`).toBeLessThan(0.2);
    });
  }

  it('ridgeRoofs off: the roof stays as the plane search drew it', () => {
    const [shape, turnDeg] = cases[0]!;
    const syn = soften(synthesize(shape, { trees: 0, turnDeg }), 0.4, 2, 0.12);
    const only = reconstructRoof(syn.raster, syn.point, { primitives: { ridgeRoofs: false, hipEnds: true } })!;
    expect(only.shapes?.filter((x) => x.kind === 'ridge-roof') ?? []).toEqual([]);
    expect(lengths(only).valley!).toBeLessThan(0.6 * shape.lines.valley!);
  });
});

describe('fitted shapes: a narrow gable is drawn whole, thin faces and all', () => {
  // A gable 2.8 m wide over a 1.5 m bump-out at 12/12, turned 12 degrees: each slope is under 0.9 m wide on average
  // (twice its area over its perimeter), like most of EagleView's dormer faces. The thin-face rule must not decide
  // the geometry: a fitted face is marked `fitted` for the checks that count thin faces.
  const shape = hipWithGableBump(1.4, 1.5, 12);
  const syn = soften(synthesize(shape, { trees: 0, turnDeg: 12 }), 0.4, 2, 0.12);

  it('its ridge and both valleys are there, its new slope marked fitted', () => {
    const roof = reconstructRoof(syn.raster, syn.point, ON)!;
    const got = lengths(roof);
    expect(roof.shapes?.map((x) => x.kind)).toEqual(['ridge-roof']);
    expect(Math.abs(got.ridge! / shape.lines.ridge! - 1), `ridge ${got.ridge}`).toBeLessThan(0.05);
    expect(Math.abs(got.valley! / shape.lines.valley! - 1), `valleys ${got.valley}`).toBeLessThan(0.1);
    const fitted = roof.faces.filter((f) => f.fitted === 'ridge-roof');
    expect(fitted.length).toBeGreaterThan(0);
    const width = (ring: readonly XY[]) => {
      let a = 0;
      let p = 0;
      ring.forEach((q, k) => {
        const r = ring[(k + 1) % ring.length]!;
        a += q.x * r.y - r.x * q.y;
        p += Math.hypot(r.x - q.x, r.y - q.y);
      });
      return Math.abs(a) / p;
    };
    expect(Math.min(...fitted.map((f) => width(f.ring))), 'a thin fitted face').toBeLessThan(0.9);
  });

  it('with the old width rule (shapeFaceWidthM 0.9) nothing is fitted and the valleys are missing', () => {
    const roof = reconstructRoof(syn.raster, syn.point, { primitives: { ...ON.primitives, shapeFaceWidthM: 0.9 } })!;
    expect(roof.shapes).toBeUndefined();
    expect(lengths(roof).valley ?? 0).toBeLessThan(0.5 * shape.lines.valley!);
  });
});

describe('fitted shapes: judged through the smoothing', () => {
  // judgeShape on a 7 x 7 m patch of a slope falling south at 6/12: the faces as they stand are that slope. Heights
  // are the true surface smoothed like Google's height map (a Gaussian of 0.35 m) plus a little noise.
  const s = 0.1;
  const g = { w: 70, h: 70 };
  const n = g.w * g.h;
  const px = (i: number) => ({ x: ((i % g.w) + 0.5) * s, y: -(Math.floor(i / g.w) + 0.5) * s });
  const host = { a: 0, b: 0.5, c: 10 };
  const z = (p: { a: number; b: number; c: number }, i: number) => p.a * px(i).x + p.b * px(i).y + p.c;
  const blur = (src: Float64Array): Float32Array => {
    const r = 10;
    const k = Array.from({ length: 2 * r + 1 }, (_, j) => Math.exp(-(((j - r) * s) ** 2) / (2 * 0.35 * 0.35)));
    const tmp = new Float64Array(n);
    const out = new Float32Array(n);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const c = i % g.w;
        const row = Math.floor(i / g.w);
        let sv = 0;
        let sw = 0;
        for (let j = -r; j <= r; j++) {
          const cc = pass === 0 ? c + j : c;
          const rr = pass === 0 ? row : row + j;
          if (cc < 0 || rr < 0 || cc >= g.w || rr >= g.h) continue;
          sv += k[j + r]! * (pass === 0 ? src[rr * g.w + cc]! : tmp[rr * g.w + cc]!);
          sw += k[j + r]!;
        }
        if (pass === 0) tmp[i] = sv / sw;
        else out[i] = sv / sw + 0.01 * Math.sin(i * 12.9898);
      }
    }
    return out;
  };
  const model = Float32Array.from({ length: n }, (_, i) => z(host, i));
  const prm = { judgeLossM: 0.1, judgePerPx: 0.0115, judgeMedM: 0.15, judgeSmoothM: 0.35 };
  // A gable 3 m wide at 12/12 standing on the slope, its ridge running north-south down the middle at 11.2 m.
  const west = { a: 1, b: 0, c: 11.2 - 3.5 };
  const east = { a: -1, b: 0, c: 11.2 + 3.5 };
  const tent = (i: number) => Math.min(z(west, i), z(east, i));

  it('a small gable the height map smoothed explains its heights better than the slope under it', () => {
    const dsm = blur(Float64Array.from({ length: n }, (_, i) => Math.max(z(host, i), tent(i))));
    const sides = [west, east].map((plane) => ({ plane, px: Int32Array.from([...Array(n).keys()].filter((i) => tent(i) > z(host, i) && z(plane, i) === tent(i))) }));
    const j = judgeShape({ g, s, dsm, tree: null, model }, sides, prm);
    expect(j.rmsBefore - j.rmsAfter, `${j.rmsBefore} -> ${j.rmsAfter}`).toBeGreaterThan(0.03);
  });

  it('a crease cut into a smooth slope explains nothing', () => {
    const dsm = blur(Float64Array.from({ length: n }, (_, i) => z(host, i)));
    // Two planes meeting in a ridge 0.15 m proud of the slope, over the same footprint as the gable's.
    const ridgeZ = (i: number) => z(host, i) + 0.15 - 0.2 * Math.abs(px(i).x - 3.5);
    const l = { a: 0.2, b: 0.5, c: 10 + 0.15 - 0.2 * 3.5 };
    const r = { a: -0.2, b: 0.5, c: 10 + 0.15 + 0.2 * 3.5 };
    const sides = [l, r].map((plane) => ({ plane, px: Int32Array.from([...Array(n).keys()].filter((i) => ridgeZ(i) > z(host, i) && Math.abs(z(plane, i) - ridgeZ(i)) < 1e-9)) }));
    const j = judgeShape({ g, s, dsm, tree: null, model }, sides, prm);
    expect(j.rmsBefore - j.rmsAfter, `${j.rmsBefore} -> ${j.rmsAfter}`).toBeLessThan(0.03);
  });
});

describe('fitted shapes: nothing is invented', () => {
  // The same roofs with the fits on and off, soft and lumpy or as the other tests have them: no shape, and the
  // reconstruction the same to the last line.
  const plain: [string, SyntheticRoof][] = [
    ['a plain gable', synthesize(GABLE, { trees: 0 })],
    ['a plain gable, soft', soften(synthesize(GABLE, { trees: 0 }), 0.7)],
    ['a plain gable, soft and lumpy', soften(synthesize(GABLE, { trees: 0, turnDeg: 0 }), 0.7, 2, 0.12)],
    ['a hip roof', synthesize(HIP, { trees: 0 })],
    ['a hip roof, soft and lumpy', soften(synthesize(HIP, { trees: 0 }), 0.7, 2, 0.12)],
    ['a cross gable', synthesize(L_CROSS, { trees: 0 })],
    ['a gable under trees', synthesize(GABLE, { trees: 3 })],
  ];
  for (const [name, syn] of plain) {
    it(`${name}: no shape, the same roof`, () => {
      const { on, off } = both(syn);
      expect(on.shapes).toBeUndefined();
      expect(on.faces.some((f) => f.fitted === 'ridge-roof' || f.fitted === 'hip-end')).toBe(false);
      expect(JSON.stringify(on)).toBe(JSON.stringify(off));
    });
  }

  it("a slope fitted as a gable (its heights bowed under its plane) is no evidence: no hip end on the gable's eave", () => {
    const syn = synthesize(BOWED_GABLE, { trees: 0 });
    const { on, off } = both(syn);
    expect(off.faces.some((f) => f.fitted === 'gable'), 'the bowed slope is fitted as a gable').toBe(true);
    expect(on.shapes).toBeUndefined();
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  });
});

describe("fitted shapes: the roof's directions", () => {
  const plane = (pitch: number, deg: number) => ({ a: pitch * Math.cos((deg * Math.PI) / 180), b: pitch * Math.sin((deg * Math.PI) / 180), c: 0 });
  const square: XY[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: -10 },
    { x: 0, y: -10 },
  ];
  const deg = (r: number) => (r * 180) / Math.PI;

  it('one axis and its quarter turn for a house square to itself', () => {
    const dirs = roofDirections([plane(0.5, 20), plane(0.5, 200), plane(0.5, 110), plane(0.5, 290)], [50, 50, 20, 20], square).map(deg);
    expect(dirs.length).toBe(2);
    expect(Math.abs(dirs[0]! - 20)).toBeLessThan(1);
    expect(Math.abs(dirs[1]! - 110)).toBeLessThan(1);
  });

  it('a wing set at an angle has its own', () => {
    const dirs = roofDirections([plane(0.5, 10), plane(0.5, 190), plane(0.5, 50), plane(0.5, 230)], [60, 60, 30, 30], square).map(deg);
    expect(dirs.length).toBe(4);
    expect(dirs.some((d) => Math.abs(d - 10) < 1)).toBe(true);
    expect(dirs.some((d) => Math.abs(d - 50) < 1)).toBe(true);
  });

  it('flat faces say nothing: the outline does', () => {
    const dirs = roofDirections([plane(0.02, 33)], [100], square).map(deg);
    expect(dirs.length).toBe(2);
    expect(Math.abs(dirs[0]! % 90)).toBeLessThan(1);
  });
});

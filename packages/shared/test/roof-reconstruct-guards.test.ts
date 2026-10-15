// One scene per guard of the hidden-edge steps, in which only that guard refuses (review finding: deleting a guard was
// invisible to the suite, because other gates happened to decline the scenes named after it). Each test asserts the
// guard's own reason and an unchanged outline; `npm run roof3d:mutate-guards` deletes each guard in turn and checks
// that a test here fails. Scenes are drawn from scratch (fixtures/plane-scene.ts, fixtures/photo-scene.ts), at 0.1 m
// (HIGH) and 0.25 m (MEDIUM) pixels unless a scene says why not.
import { describe, expect, it } from 'vitest';
import type { XY } from '../src/roof-reconstruct/geom.ts';
import { inferHiddenEaves, type OutlinePlanesParams, type PlanesDecline } from '../src/roof-reconstruct/outline-planes.ts';
import { photoEdges, type PhotoEdgeParams, type PhotoEdgeReason } from '../src/roof-reconstruct/outline-photo.ts';
import { box, disc, pixelHash, planeInput, type PlaneScene } from './fixtures/plane-scene.ts';
import { CORRECT, hash01, LEAF_RGB, render, ROOF, ROOF_RGB, type Scene, SHORT } from './fixtures/photo-scene.ts';

// ---------------------------------------------------------------------------------------------------------------
// Planes (outline-planes.ts). A gable 12 x 10 m at 6/12 (eaves 3 m up, south and north), or a hip of the same size;
// Google's outline bitten under a dense crown. Most scenes run in hypothesis mode (minDeepSeenShare 0) so that the
// evidence check does not decline first; the evidence check has scenes of its own.
// ---------------------------------------------------------------------------------------------------------------

const GABLE = [
  { a: 0, b: 0.5, c: 10 },
  { a: 0, b: -0.5, c: 1 },
];
/** A hip: south, north, west and east faces; `eastC` 11 puts the east eave at 3 m like the others. */
const hip = (eastC: number) => [...GABLE, { a: 0.5, b: 0, c: 1 }, { a: -0.5, b: 0, c: eastC }];
const ring = (...pts: [number, number][]): XY[] => pts.map(([x, y]) => ({ x, y }));
const HYPOTHESIS: Partial<OutlinePlanesParams> = { minDeepSeenShare: 0 };

/** A 4 x 2 m bite out of the south eave under a dense crown: the move every other scene varies. */
const BITE: PlaneScene = {
  s: 0.1,
  sizeM: 20,
  planes: GABLE,
  onRoof: box(4, -14, 16, -4),
  outline: ring([4, -14], [8, -14], [8, -12], [12, -12], [12, -14], [16, -14], [16, -4], [4, -4]),
  crown: disc(10, -13.5, 2.6),
};
/** The south-east corner of a hip bitten on its south side: the moved eave meets the kept east eave. */
const CORNER: PlaneScene = {
  ...BITE,
  planes: hip(11),
  outline: ring([4, -14], [12, -14], [12, -12.5], [16, -12.5], [16, -4], [4, -4]),
  crown: disc(14.5, -13.8, 2.4),
};
/** The south-east corner of a hip cut by a crown's 45-degree chamfer (legs 2.8 m). */
const CHAMFER: PlaneScene = { ...BITE, planes: hip(11), outline: ring([4, -14], [13.2, -14], [16, -11.2], [16, -4], [4, -4]), crown: disc(16.3, -14.3, 2.7) };
/** The chamfer counts as no face's eave (45 degrees off both faces' downhill) when the normal limit is 40 degrees. */
const CHAMFER_PRM: Partial<OutlinePlanesParams> = { ...HYPOTHESIS, maxNormalDeg: 40 };
const inChamfer = (q: XY) => q.x <= 16 && q.y >= -14 && q.x - q.y - 27.2 > 0;
const fromChamfer = (q: XY) => Math.abs(q.x - q.y - 27.2) / Math.SQRT2;

function planes(sc: PlaneScene, s: number, prm: Partial<OutlinePlanesParams>) {
  const input = planeInput({ ...sc, s });
  const res = inferHiddenEaves(input, prm);
  if (!res.ok) throw new Error(`refused: ${res.reason}`);
  return { res, input };
}

/** The step refused, for exactly this reason, and the outline is as it came. */
function refusedFor(sc: PlaneScene, s: number, prm: Partial<OutlinePlanesParams>, why: PlanesDecline) {
  const { res, input } = planes(sc, s, prm);
  expect(res.changes).toEqual([]);
  expect(res.outline).toEqual(input.outline);
  expect(res.declined).toEqual({ [why]: 1 });
}

describe('planes step guards: each refuses its own scene', () => {
  for (const s of [0.1, 0.25]) {
    describe(`${s} m pixels`, () => {
      it('control: the bite under a dense crown is filled in hypothesis mode (so each refusal below is the guard)', () => {
        const { res } = planes(BITE, s, HYPOTHESIS);
        expect(res.changes).toHaveLength(1);
        expect(res.declined).toEqual({});
      });
      it('offset: a bite deeper than 3 m (inner corners 3.5 m from the eave line)', () => {
        const deep: PlaneScene = { ...BITE, outline: ring([4, -14], [8, -14], [8, -10.5], [12, -10.5], [12, -14], [16, -14], [16, -4], [4, -4]), crown: disc(10, -12.5, 3.2) };
        refusedFor(deep, s, HYPOTHESIS, 'offset');
      });
      it('offset: a bulge more than 1 m past the eave line (a crown the mask took for roof, 1.3 m out)', () => {
        const bulge: PlaneScene = { ...BITE, outline: ring([4, -14], [8, -14], [8, -15.3], [12, -15.3], [12, -14], [16, -14], [16, -4], [4, -4]), crown: disc(10, -15.3, 2.6), crownIn: box(8, -15.3, 12, -14) };
        refusedFor(bulge, s, HYPOTHESIS, 'offset');
      });
      it("disagrees-visible: the piece's own visible samples (yard seen right under the bite's edge) are 2 m off the line", () => {
        refusedFor({ ...BITE, ground: box(8, -13.2, 9.8, -12) }, s, HYPOTHESIS, 'disagrees-visible');
      });
      it('other-building: another building stands in the swept strip', () => {
        refusedFor({ ...BITE, other: box(9.8, -13.8, 10.2, -13.4) }, s, HYPOTHESIS, 'other-building');
      });
      it('yard-visible: ground shows through the leaves in 14 % of the swept strip (beyond the eave samples\' reach)', () => {
        refusedFor({ ...BITE, ground: box(9.3, -14, 10.7, -13.2) }, s, HYPOTHESIS, 'yard-visible');
      });
      it("roof-visible: an inward move would cut off roof that lies on the face's plane (a 0.8 m porch on the same plane)", () => {
        const porch: PlaneScene = {
          ...BITE,
          onRoof: (q) => box(4, -14, 16, -4)(q) || box(8, -14.8, 12, -14)(q),
          outline: ring([4, -14], [8, -14], [8, -14.8], [12, -14.8], [12, -14], [16, -14], [16, -4], [4, -4]),
          crown: disc(10, -15.3, 2.4),
        };
        refusedFor(porch, s, HYPOTHESIS, 'roof-visible');
      });
      it("no-corner: the moved eave meets the kept east eave off their planes' crease (east wall plate 0.4 m higher)", () => {
        expect(planes(CORNER, s, HYPOTHESIS).res.changes).toHaveLength(1);
        refusedFor({ ...CORNER, planes: hip(11.4) }, s, HYPOTHESIS, 'no-corner');
      });
      it('large-change: filling the bite would change a small roof by over 25 % (13 m2 of 48)', () => {
        const small: PlaneScene = {
          s,
          sizeM: 16,
          planes: [
            { a: 0, b: 0.5, c: 8 },
            { a: 0, b: -0.5, c: 1 },
          ],
          onRoof: box(4, -10, 12, -4),
          outline: ring([4, -10], [5.5, -10], [5.5, -7.4], [10.5, -7.4], [10.5, -10], [12, -10], [12, -4], [4, -4]),
          crown: disc(8, -9, 3),
        };
        refusedFor(small, s, HYPOTHESIS, 'large-change');
      });
      it('unconfirmed: by default a dense crown gives no evidence that the 2 m2 beyond the overhang is roof', () => {
        refusedFor(BITE, s, {}, 'unconfirmed');
      });
      it('unconfirmed, the other way: the plane seen through 40 % of the deep part is evidence enough', () => {
        const seen = { ...BITE, roofSeen: (q: XY) => box(9.1, -14, 10.9, -13.1)(q) && pixelHash(q.x, q.y, s) < 0.4 };
        expect(planes(seen, s, {}).res.changes).toHaveLength(1);
      });

      // The chamfer (a crown's diagonal cut across a hip corner) is dropped for the corner where the two eaves meet.
      const chamferOutcome = (sc: PlaneScene, prm: Partial<OutlinePlanesParams>) => {
        const { res, input } = planes(sc, s, prm);
        return { res, input, outcome: res.pieces.find((p) => p.face === -1)?.outcome };
      };
      it('chamfer control: dropped for the hip corner in hypothesis mode', () => {
        const { res, outcome } = chamferOutcome(CHAMFER, CHAMFER_PRM);
        expect(outcome).toBe('replaced');
        expect(res.changes).toHaveLength(1);
      });
      for (const [name, sc, prm, why] of [
        ['ground shows in a fifth of the corner it would add', { ...CHAMFER, ground: (q: XY) => inChamfer(q) && fromChamfer(q) > 1.15 }, CHAMFER_PRM, 'yard-visible'],
        ['another building stands in that corner', { ...CHAMFER, other: box(15.2, -13.8, 15.6, -13.4) }, CHAMFER_PRM, 'other-building'],
        ['by default, nothing in that corner shows the roof (dense crown)', CHAMFER, { maxNormalDeg: 40 }, 'unconfirmed'],
      ] as const) {
        it(`chamfer refused (${why}): ${name}`, () => {
          const { res, input, outcome } = chamferOutcome(sc, prm);
          expect(outcome).toBe(why);
          expect(res.changes).toEqual([]);
          expect(res.outline).toEqual(input.outline);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Photo (outline-photo.ts). The house of the photo tests: roof to x = 20 m, the outline 1 m short at 19 under a crown.
// ---------------------------------------------------------------------------------------------------------------

const OTHER_RGB = [70, 60, 140] as const;
const sparse = (x: number, leaves: number) => ({ x, y: -16, r: 4.5, leaves });

/** The east edge (edge 1) and the outline: refused for exactly `why`, the outline as it came. */
function photoRefused(sc: Scene, outlineHouse: readonly XY[], s: number, why: PhotoEdgeReason, prm: Partial<PhotoEdgeParams> = {}) {
  const { raster, outline } = render(sc, outlineHouse, s);
  const res = photoEdges(outline, raster, prm);
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  const east = res.edges.find((e) => e.edge === 1)!;
  expect(east.reason).toBe(why);
  expect(east.status).not.toBe('moved');
  expect(res.edges.every((e) => e.status !== 'moved')).toBe(true);
  expect(res.outline).toEqual(outline.map((p) => ({ x: p.x, y: p.y })));
}

describe('photo step guards: each refuses its own scene', () => {
  for (const s of [0.1, 0.25]) {
    describe(`${s} m pixels`, () => {
      it('control: the eave under a sparse crown moves 1 m out to where the photo shows the roof ending', () => {
        const { raster, outline } = render({ roof: ROOF, crown: sparse(20, 0.5) }, SHORT, s);
        const res = photoEdges(outline, raster);
        expect(res.ok && res.edges[1]!.status).toBe('moved');
      });
      it('not-crown: what hides the eave is a smooth, roof-coloured deck at eave height, not a crown', () => {
        const deck: Scene = {
          roof: { ...ROOF, x1: 19 },
          paint: (p, px) => {
            if (p.x > 19 && p.x <= 21 && p.y >= -23 && p.y <= -9) {
              px.z = 5;
              px.col = ROOF_RGB;
            }
          },
        };
        photoRefused(deck, SHORT, s, 'not-crown');
      });
      it('weak-contrast: the yard beyond is as roof-coloured as the roof (6 m of concrete)', () => {
        photoRefused({ roof: ROOF, crown: sparse(20, 0.5), patioM: 6 }, SHORT, s, 'weak-contrast');
      });
      it('no-gain: the best line is not clearly better than the current edge (gain needed above 1)', () => {
        photoRefused({ roof: ROOF, crown: sparse(20, 0.5) }, SHORT, s, 'no-gain', { minGain: 1.01 });
      });
      it('no-consensus: the columns along the edge must agree (all of them asked for)', () => {
        photoRefused({ roof: ROOF, crown: sparse(20, 0.5) }, SHORT, s, 'no-consensus', { minConsensus: 1.01 });
      });
      it('ground: the photo says roof (a roof-coloured patio) but the heights between the leaves say ground', () => {
        photoRefused({ roof: { ...ROOF, x1: 19 }, crown: sparse(19.5, 0.6), patioM: 1 }, SHORT, s, 'ground');
      });
      it("neighbour-roof: the swept strip is another mask part's roof", () => {
        const sc: Scene = {
          roof: ROOF,
          crown: sparse(20, 0.5),
          paint: (p, px) => {
            if (p.x > 19.2 && p.x <= 19.8 && p.y >= -18 && p.y <= -14) {
              px.mask = 1;
              px.roof = 0;
            }
          },
        };
        photoRefused(sc, SHORT, s, 'neighbour-roof');
      });
      it('large-change: a 1 m move would grow a 3 m wide roof by a third', () => {
        photoRefused({ roof: { ...ROOF, x0: 16 }, crown: sparse(20, 0.5) }, ring([16, -23], [19, -23], [19, -9], [16, -9]), s, 'large-change');
      });
    });
  }

  // At 0.25 m the crown's 0.6-1 m reach beyond the edge is two pixels, and this scene's edge reads as supported.
  it("not-occluded (0.1 m): an inward move would cut off visible roof (a differently coloured band), not canopy", () => {
    const band: Scene = {
      roof: ROOF,
      paint: (p, px, c, r) => {
        if (p.x > 18.5 && p.x <= 20 && p.y >= -23 && p.y <= -9) px.col = OTHER_RGB;
        if (p.x > 20.2 && p.x <= 23 && p.y >= -24 && p.y <= -8 && hash01(c, r, 3) < 0.75) {
          px.z = 7 + 0.4 * (hash01(r, c, 4) - 0.5);
          px.col = LEAF_RGB;
        }
      },
    };
    photoRefused(band, CORRECT, 0.1, 'not-occluded');
  });
});

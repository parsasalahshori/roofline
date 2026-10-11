### Task 2: Shared roof geometry and the instant estimate

**Base:** `e1-estimator` after Task 1 is merged. Pure; no C1 dependency. `roof.ts` is a T1 placeholder in the barrel.

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 geometry (`polygonAreaSqFt`, `perimeterFt`, `offsetOutline`, `minRotatedRectangle`) ; Builder 2 `instantEstimate`; Builder 3 tests with fixture outlines.

**Files:** Modify `packages/shared/src/roof.ts`; Test `packages/shared/test/roof.test.ts`, fixtures `packages/shared/test/fixtures/outlines.ts`.

**Interfaces:**
```ts
export type LngLat = [number, number];
export type Ring = LngLat[];                                   // closed or open; first ≠ last accepted
export type Outline = Ring[];                                  // one ring per included structure (no holes)
export function polygonAreaSqFt(ring: Ring): number;           // local equirectangular projection at the ring's centroid latitude; exact enough < 0.5% for house-sized rings
export function perimeterFt(ring: Ring): number;
export function pitchFactor(pitchX12: number): number;         // √(1 + (p/12)²)
export function minRotatedRectangle(ring: Ring): { longFt: number; shortFt: number };
export function outlineProblem(ring: Ring): 'too_few_corners' | 'self_intersecting' | 'too_large' | null;   // < 3 corners; edges crossing; > 200,000 sq ft
export type InstantInput = { outline: Outline; pitchX12: number; overhangFt: number; valleyFt?: number };
export type InstantEstimate = { footprintSqFt: number; planSqFt: number; surfaceSqFt: number; squares: number; edgeFt: number; ridgeFt: number; valleyFt: number; pitchX12: number };
export function instantEstimate(i: InstantInput): InstantEstimate;
```
- **Formulas (spec §3.2):** per ring: footprint = area; plan = footprint + perimeter × overhang; surface = plan × pitchFactor; edges = `perimeterFt(ring) + 8 * overhangFt` (the offset perimeter of a rectangle-like ring; documented as an allowance); ridge = `minRotatedRectangle(ring).longFt`; sums over rings; `squares = surfaceSqFt / 100`; round areas to 1 decimal, lengths to 0.1 ft.

**Tests:**
- a 40 ft × 30 ft rectangle at Omaha's latitude → footprint 1,200 ± 0.5%; perimeter 140 ± 0.5%; 6/12 → factor 1.1180; overhang 1 → plan 1,340, surface ≈ 1,498.1, edges 148, ridge 40; an L-shape fixture; two rings sum; problems (2 corners, a bow-tie, a warehouse).

**Carries and rulings:**
- Pure math only; no UI text.

**Verify notes:**
- `npx vitest run --project @roofline/shared roof`.
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(shared): roof outline geometry and the instant estimate`

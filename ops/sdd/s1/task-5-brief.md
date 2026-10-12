### Task 5: Shared door routes — k-means and 2-opt

**Base:** `s1-storm` after Task 1 is merged. Pure; no dependencies beyond T1's placeholder.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 seeded k-means with balanced sizes; Builder 2 nearest neighbour + 2-opt; Builder 3 `splitIntoRoutes` and tests.

**Files:** Modify `packages/shared/src/door-routes.ts`; Test `packages/shared/test/door-routes.test.ts`.

**Interfaces:**
```ts
export type Door = { key: string; lat: number; lng: number; hailIn: number };
export type PlannedRoute = { repIndex: number; doors: Door[]; walkMeters: number };
export const MAX_DOORS_PER_ROUTE = 150; export const MAX_DOORS_PER_PLAN = 1500;
export function pickDoors(all: Door[], max = MAX_DOORS_PER_PLAN): Door[];          // largest hail first, then key
export function clusterDoors(doors: Door[], k: number, seed: string): Door[][];       // k-means++ with a seeded PRNG (mulberry32 of a string hash), ≤ 25 iterations, equirectangular metres
export function orderRoute(doors: Door[]): { doors: Door[]; walkMeters: number };     // nearest neighbour from the door nearest the cluster's north-west corner, then 2-opt until no gain (cap 50 passes)
export function splitIntoRoutes(doors: Door[], reps: number, seed: string): PlannedRoute[];
    // k = max(reps, ceil(n / 150)); clusters over 150 are split by orderRoute halves; routes assigned to reps round-robin by door count (largest to the rep with fewest doors)
```

**Tests:**
- deterministic for a seed; every door exactly once; ≤ 150 each; 2-opt never longer than nearest neighbour; 1 rep with 400 doors → 3 routes on rep 0; empty input → `[]`; 1,500 doors in < 1 s (timed loosely).

**Carries and rulings:**
- Deterministic for a seed; no `Math.random`.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(shared): door-knock routes by clustering and 2-opt`

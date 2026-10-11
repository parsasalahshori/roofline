### Task 2: Shared pipeline rules

**Base:** `c1-crm` after Task 1 is merged. From F1 (`@roofline/shared` `enums.ts`): `JOB_STAGES`, `JobStage`, `JOB_STAGE_LABELS` (server-side labels; the web uses copy). From F1 `time-zone.ts`: `localDate(now, zone)`, `isTimeZone`. Task 1 left `packages/shared/src/pipeline.ts` as `export {};` (already in the barrel).

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:** Builder 1 the rules; Builder 2 the tests.

**Files:**
- Modify: `packages/shared/src/pipeline.ts`
- Test: `packages/shared/test/pipeline.test.ts`

**Interfaces:**
```ts
export const BOARD_STAGES = ['lead', 'inspection', 'proposal', 'won', 'installed'] as const;   // Lost is the drawer
export type BoardStage = (typeof BOARD_STAGES)[number];
export const STUCK_STAGES: readonly JobStage[] = ['lead', 'inspection', 'proposal'];
export const BOARD_INSTALLED_DAYS = 30;
export const NEXT_STEP_MAX = 120;
export const LOST_REASON_MAX = 200;
export type StageMove = { from: JobStage; to: JobStage; valueCents: number | null; lostReason: string | null };
export type StageMoveProblem = { field: 'stage' | 'lostReason' | 'valueCents'; problem: 'installed_needs_won' | 'lost_needs_reason' | 'won_needs_value' };
export function stageMoveProblem(m: StageMove): StageMoveProblem | null;
export function daysInStage(stageChangedAt: Date, now: Date, timeZone: string): number;   // whole calendar days in the zone (same day → 0)
export function isStuck(stage: JobStage, days: number, stuckAfterDays: number): boolean;   // STUCK_STAGES and days > stuckAfterDays
```
- **Rules (spec §3.2):** `from === to` → null. `to === 'installed'` and `from !== 'won'` and `from !== 'installed'` → `installed_needs_won` (field `stage`). `to === 'lost'` and `lostReason` blank → `lost_needs_reason`. `to === 'won'` and not `valueCents > 0` → `won_needs_value` (field `valueCents`). Everything else → null.
- No UI text here; the API maps `problem` to its message constants and the web to copy.

**Tests:**
- every rule both ways (lead→won with and without value; inspection→installed refused; won→installed ok; any→lost needs reason, whitespace-only counts as blank; lost→lead ok; same stage null); `daysInStage` across midnight in `America/Chicago` and across the 2026-11-01 DST change; `isStuck` at 14 and 15 days, and never for won/installed/lost.

**Carries and rulings:**
- Copy rules: `npx vitest run --project @roofline/web copy-rules` must stay green with the new `as const` arrays (none of their values may appear as words in copy).

**Verify notes:**
- `npx vitest run --project @roofline/shared pipeline` → PASS; `npx vitest run --project @roofline/web copy-rules` (new `as const` arrays) → PASS.
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); still confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(shared): pipeline stage rules and stuck days`

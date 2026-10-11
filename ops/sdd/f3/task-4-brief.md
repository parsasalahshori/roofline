### Task 4: Shared setup checklist rules

**Base:** `f3-setup` after F3 Task 1 is merged (or stacked on `f3-t1`). Task 1 already put `SETUP_ITEM_KEYS`, `SetupItemKey`, `SETUP_STATUSES` and `SetupStatus` in `packages/shared/src/setup.ts` (in the shared barrel). `CampaignStatus` (`'none' | 'pending' | 'approved' | 'rejected'`) is in `packages/shared/src/enums.ts`. No F2 dependency.

**Split:** (two builders; the plan's split)
- Builder 1: the rules in `packages/shared/src/setup.ts`.
- Builder 2: `packages/shared/test/setup.test.ts`.

**Files:**
- Modify: `packages/shared/src/setup.ts` (append below Task 1's constants; keep them as they are)
- Test: `packages/shared/test/setup.test.ts`
- Do not touch: `packages/shared/src/index.ts`, `packages/shared/test/f3-constants.test.ts` (Task 1's).

**Interfaces:**
```ts
export const COMING_WITH = ['estimator', 'calendar', 'front_desk', 'storm_scout'] as const; export type ComingWith = (typeof COMING_WITH)[number];
export const FOUNDATION_ITEMS: readonly SetupItemKey[] = ['company_basics','import_customers','texting_registration','invite_team','payment_method'];
export const SKIPPABLE: ReadonlySet<SetupItemKey> = new Set(['import_customers', 'invite_team']);
export type SetupFacts = { addressSaved: boolean; located: boolean; serviceArea: boolean;
  imports: { done: number; running: number };
  texting: { campaignStatus: CampaignStatus; rejectionReason: string | null; rejectedFields: string[] };
  activeMembers: number; pendingInvites: number; paymentMethod: boolean; skipped: ReadonlySet<SetupItemKey> };
export type SetupItemView = { key: SetupItemKey; status: SetupStatus; comingWith: ComingWith | null; skippable: boolean; data: Record<string, unknown> };
export type SetupView = { items: SetupItemView[]; progress: { done: number; total: number } };
export function deriveSetup(facts: SetupFacts): SetupView;
```
- **Rules,** one item per key in `SETUP_ITEM_KEYS` order. A real `done` always beats a stored skip. `data` is `{}` unless stated. `skippable` is `SKIPPABLE.has(key)`. `comingWith` is null except the four later-spec items.
  - **`company_basics`:** `done` when `located && serviceArea`; `in_progress` when `addressSaved && !located`; else `todo`. `data {located, serviceArea}`.
  - **`import_customers`:** `done` when `imports.done > 0`; else `in_progress` when `imports.running > 0`; else `skipped` when in `skipped`; else `todo`.
  - **`texting_registration`:** `done` when `approved`; `waiting` when `pending`; `todo` with `data {rejected: true, reason: rejectionReason, fields: rejectedFields}` when `rejected`; else `todo`.
  - **`invite_team`:** `done` when `activeMembers >= 2`; else `in_progress` when `pendingInvites > 0`; else `skipped` when skipped; else `todo`.
  - **`payment_method`:** `done` when `paymentMethod`, else `todo`. (A stored skip of a non-skippable key is ignored.)
  - **Later-spec items** are `todo` with `comingWith`: `prices_and_tiers` → `estimator`, `connect_calendar` → `calendar`, `phone_number` → `front_desk`, `connect_ads` → `storm_scout`.
  - **Progress:** `total: 5` (`FOUNDATION_ITEMS.length`); `done` counts the Foundation items whose status is `done` or `skipped`.

**Tests (`packages/shared/test/setup.test.ts`)** — a `facts(overrides)` helper builds all-false facts (`campaignStatus: 'none'`, zero counts, empty `skipped`).
- `it('a brand-new company has everything to do')`: nine items in `SETUP_ITEM_KEYS` order; the five Foundation items `todo` with `comingWith: null`; the four others `todo` with the `comingWith` above; `progress` `{ done: 0, total: 5 }`.
- `it('a located company with a card and a teammate')`: `addressSaved, located, serviceArea: true`, `paymentMethod: true`, `activeMembers: 2` → `company_basics`, `invite_team`, `payment_method` are `done`; `progress {done: 3, total: 5}`; `company_basics.data` equals `{ located: true, serviceArea: true }`.
- `it('waiting on carriers, and a rejection with its reason')`: `pending` → `texting_registration` `waiting`; `rejected` with reason `'R'` and fields `['ein']` → `{ status: 'todo', data: { rejected: true, reason: 'R', fields: ['ein'] } }`.
- `it('skips only what may be skipped, and done beats skipped')`: skipped `import_customers` with `imports.done: 1` → `done`; skipped `import_customers` with nothing → `skipped` and counts toward progress; skipped `payment_method` → still `todo`; `skippable` is true only for `import_customers` and `invite_team`.
- `it('invites pending is started')`: `pendingInvites: 1, activeMembers: 1` → `invite_team` `in_progress`; an import with `running: 1` → `import_customers` `in_progress`; `addressSaved` without `located` → `company_basics` `in_progress`.

**Verify notes:**
- `npx vitest run --project @roofline/shared` (no database), then `npm run typecheck && npm run lint`.
- `COMING_WITH` adds the snake_case words `front_desk`/`storm_scout` (already banned via `AGENTS`); run `npx vitest run --project @roofline/web copy-rules` to confirm the web copy is unaffected.
- Commit: `feat(shared): setup checklist rules`.

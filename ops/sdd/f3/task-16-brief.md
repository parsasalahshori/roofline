### Task 16: Setup checklist API

**Base:** `f3-setup` after Task 9 is merged (T4 is in). From T4 (`packages/shared/src/setup.ts`): `deriveSetup`, `SetupFacts`, `SetupItemView`, `SetupView`, `SKIPPABLE`, `SETUP_ITEM_KEYS`, `SetupItemKey`. From T1: `setup_items` table (`setupItems`: `companyId`, `key`, `status`, `data`, timestamps, unique `(company_id, key)`; tenant SELECT/INSERT/UPDATE), placeholder `packages/db/src/repos/setup.ts` (in the barrel). From T9: the stub `apps/api/src/account/setup-routes.ts` (`setupRoutes(deps): Router`, mounted at `/api/setup`), `billing/guards.ts` `hasPaymentMethod`. `listPendingInvites(system, companyId, now)` is in `packages/db/src/system/team.ts` (`@roofline/db/system`, allowed in `account/**` since T9).

**Split:**
- Builder 1: `packages/db/src/repos/setup.ts`.
- Builder 2: `apps/api/src/account/setup-routes.ts`.
- Builder 3: `apps/api/test/setup.test.ts`.

**Files:**
- Modify: `packages/db/src/repos/setup.ts`, `apps/api/src/account/setup-routes.ts`
- Test: `apps/api/test/setup.test.ts`
- Do not touch: `app.ts` (already mounted), `packages/shared/src/setup.ts`.

**Interfaces:**
```ts
export async function setupFacts(tx: Tx, ctx: TenantContext): Promise<Omit<SetupFacts, 'pendingInvites'>>;
export async function saveSetupItems(tx: Tx, ctx: TenantContext, items: readonly SetupItemView[], now: Date): Promise<void>;   // upsert status + data on (company_id, key)
export async function setSetupSkipped(tx: Tx, ctx: TenantContext, key: SetupItemKey, skipped: boolean, now: Date): Promise<void>;
```
- **Where each fact comes from** (all tenant reads):
  - `addressSaved`: `companies.address_street` not null; `located`: `location` not null; `serviceArea`: `service_area` not null.
  - `imports`: `done` = count of `status = 'done'`; `running` = count of `status in ('queued','processing')`.
  - `texting`: from the readable `texting_registrations` columns — `campaignStatus` (`'none'` without a row), `rejectionReason` = `rejection_reason_plain`, `rejectedFields` = `rejected_fields` (`text[]`).
  - `activeMembers`: count of `company_members` with `status = 'active'`.
  - `paymentMethod`: `hasPaymentMethod({ stripeSubscriptionId, status })` semantics — `stripe_subscription_id` set and status `active` or `past_due`. (`repos/` may not import from `apps/api`; repeat the two-line rule in SQL/TS here.)
  - `skipped`: keys whose stored `setup_items.status = 'skipped'`.
- **`setSetupSkipped`:** upserts the row with `status 'skipped'` (skip) or `'todo'` (unskip); the next `GET` re-derives the real status.
- **rejectedFields carry (proposed Ruling X):** T4's `SetupFacts.texting.rejectedFields` stays `string[]` (the column is `text[]`); `setupFacts` filters it to `BRAND_FIELDS` members (`(BRAND_FIELDS as readonly string[]).includes(f)`) so `data.fields` only ever holds `BrandField` values the web can highlight. No change to T4's or T5's types.
- **Routes** (`setupRoutes`):
  - `GET /api/setup`: any member. In one `withTenant`: `setupFacts`, plus `pendingInvites = (await listPendingInvites(deps.pools.system, companyId, now)).length` (outside the tenant tx), `deriveSetup`, then `saveSetupItems`. Returns the `SetupView`.
  - `POST /api/setup/:key/skip` and `POST /api/setup/:key/unskip`: `requireCapability('company_admin')`. Unknown key → 404 (the standard not-found body). Key not in `SKIPPABLE` → 400 "This step can't be skipped." Success → `setSetupSkipped`, audit `setup.skip` / `setup.unskip` `{ key }`, then the fresh `SetupView`.
  - Messages are constants in `setup-routes.ts` (Ruling 33), not in `errors.ts`.

**Tests (`setup.test.ts`)** — `makeTestApp`, `loginAs`:
- `test('a new company starts with nine items, five to do')`: owner `GET /api/setup` → `progress { done: 0, total: 5 }`, 9 items in key order; then `select count(*) from setup_items where company_id = A` = 9.
- `test('a located company has its basics done')`: set `location` and `service_area` by SQL (owner client) → `company_basics` `done`, `progress.done 1`.
- `test('skipping the import counts toward progress, and unskip undoes it')`: skip → `import_customers` `skipped`, `progress.done 1`; unskip → `todo`, `progress.done 0`.
- `test('texting cannot be skipped')` → 400 "This step can't be skipped."
- `test('a pending invite shows the team step as started')`: create an invite (`POST /api/team/invites`) → `invite_team` `in_progress`.
- `test('a pending registration is waiting')`: set `texting_registrations.campaign_status = 'pending'` by SQL → `texting_registration` `waiting`.
- `test('a rejection lists only real brand fields')`: `campaign_status 'rejected'`, `rejection_reason_plain 'R'`, `rejected_fields '{ein,bogus}'` → `data { rejected: true, reason: 'R', fields: ['ein'] }`.
- `test('office can read but not skip; reps can read')`: office GET 200, skip 403; rep GET 200.
- `test("company B never sees A's checklist")`: A skips import; B's `GET` shows `import_customers` `todo`.

**Verify notes:**
- api suite needs Docker (none here): locally `npm run typecheck && npm run lint`; prove with `ops/bin/ci-check`.
- Commit: `feat(setup): checklist API derived from the company's real records`.

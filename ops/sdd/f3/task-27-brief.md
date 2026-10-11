### Task 27: Texting provisioning at sign-up, and the registration submit

**Base:** `f3-setup` after Tasks 9 and **17** are merged (T5 is in). From T9: stubs `apps/api/src/jobs/scheduler/provision-texting.ts` (`provisionTexting(deps, now)`, every minute), `apps/api/src/account/texting-routes.ts` (`textingRoutes(deps)`, mounted at `/api/texting`), `apps/api/src/account/texting/advance.ts` (`advanceRegistration(deps, companyId)`, wired in `JOB_HANDLERS['texting-registration']`), `account/texting/progress.ts` (`continueRegistration`, a no-op until T28), `deps.registrar` (`TestApp.registrar` = `FakeTextingRegistrar` with `calls`, `failNext(method, …)`, `setBrand`), `deps.jobs`, `billing/plans.ts` `billingConfig`, `billing/guards.ts` `hasPaymentMethod`. From T17: `public/policy-urls.ts` `policyUrls(config, slug)`. From T5: `BrandInfoSchema`, `BrandInfo`, `TextingView`, `plainRejection`. From T1: `texting_registrations` new columns (`customer_profile_sid`, `trust_product_sid`, `brand_info`, `rejected_fields`, `last_checked_at`), placeholder `packages/db/src/system/texting.ts` (in the system barrel), `recordUsage`. Existing: `encrypt(plain, keyB64): Buffer`/`decrypt(box, keyB64): string` exported from `@roofline/db`, `signingTokenFor` in `system/routing.ts`, `MESSAGES.verifyEmailFirst` in `errors.ts`.
**Chain:** T28 adds to `system/texting.ts` and fills `progress.ts` after this task.

**Split:**
- Builder 1: `packages/db/src/system/texting.ts` and `apps/api/src/jobs/scheduler/provision-texting.ts`.
- Builder 2: `apps/api/src/account/texting-routes.ts` and `apps/api/src/account/texting/view.ts`.
- Builder 3: `apps/api/src/account/texting/advance.ts` (stage 1) and the tests.

**Files:**
- Create: `apps/api/src/account/texting/view.ts`
- Modify: `packages/db/src/system/texting.ts`, `apps/api/src/jobs/scheduler/provision-texting.ts`, `apps/api/src/account/texting-routes.ts`, `apps/api/src/account/texting/advance.ts`
- Test: `apps/api/test/texting-provision.test.ts`, `apps/api/test/texting-submit.test.ts`
- Do not touch: `progress.ts` (T28), `hooks/twilio-registration.ts` (T28), `providers/**`.

**Interfaces:**
```ts
// system/texting.ts
export type RegistrationRecord = typeof textingRegistrations.$inferSelect;
export async function companiesNeedingSubaccount(system: Db, limit: number): Promise<string[]>;   // status <> 'canceled', and no row or subaccount_sid null; oldest companies first
export async function saveSubaccount(system: Db, companyId: string, sid: string, tokenEncrypted: Buffer): Promise<void>;   // insert the row, or fill only a null sid (never overwrite)
export async function loadRegistration(system: Db, companyId: string): Promise<RegistrationRecord | null>;
export async function saveSubmission(system: Db, companyId: string, brand: BrandInfo, now: Date): Promise<'saved' | 'already_waiting'>;
export async function updateRegistration(system: Db, companyId: string, patch: Partial<RegistrationRecord>): Promise<void>;
export async function withRegistrationLock<T>(system: Db, companyId: string, fn: (tx: Db) => Promise<T>): Promise<T | 'busy'>;   // SELECT … FOR UPDATE NOWAIT; lock_not_available (55P03) → 'busy'
// account/texting/view.ts
export async function textingView(deps: AppDeps, ctx: TenantContext, session: SessionInfo): Promise<TextingView>;
// account/texting/advance.ts
export async function advanceRegistration(deps: AppDeps, companyId: string): Promise<void>;
export function subaccountRef(row: RegistrationRecord, encryptionKey: string): SubaccountRef;   // decrypts the stored token
// jobs/scheduler/provision-texting.ts
export async function provisionTexting(deps: AppDeps, now: Date): Promise<void>;
```
- **`provisionTexting`:** returns at once when `!deps.registrar.configured`. Up to 20 companies per tick (`companiesNeedingSubaccount(system, 20)`), each in its own try/catch (`deps.logError`): `ensureSubaccount(companyId)`, encrypt the token with `ENCRYPTION_KEY`, `saveSubaccount`.
- **`saveSubmission`:** in one transaction with the row locked (insert the row when missing): allowed only when `campaign_status` is `none` or `rejected` → sets `brand_info`, `submitted_at`, `campaign_status 'pending'`, `rejected_fields '{}'`, `rejection_reason_plain null` → `'saved'`. It never clears the stored sids (they are the `previous` ids of a resubmission); otherwise `'already_waiting'`.
- **`GET /api/texting`** (any member) → `TextingView`:
  - `state`: `not_started` before a submission (`campaign_status 'none'`), `waiting` while `pending`, `approved`, `needs_fix` when `rejected`.
  - `reason` = `rejection_reason_plain`; `rejectedFields` = `rejected_fields` filtered to `BRAND_FIELDS` (Ruling X); `brand` = `brand_info` parsed (`BrandInfoSchema.safeParse`, null on failure); `submittedAt`/`approvedAt` ISO; `number` = the company's active `main` number e164 or null.
  - `defaults`: `legalName` = `legal_name ?? name`; `street`/`city`/`state`/`zip` from the company address; `website`; `contactEmail` = the signed-in user's email; `contactPhone` = the company phone.
  - `hostedPolicyUrls` = `policyUrls(config, slug)`; `needsPaymentMethod` = `!hasPaymentMethod(...)`; `needsVerifiedEmail` = `!session.emailVerified`.
  - Reads registration columns through the tenant-readable grant, or `loadRegistration` (allowed in `account/**`) — never select `subaccount_auth_token_encrypted` in a tenant query.
- **`POST /api/texting/registration { brand, useHostedPolicyPages }`** (`requireCapability('company_admin')`):
  - unverified email → 403 `MESSAGES.verifyEmailFirst`; no payment method → 403 "Add a card first. Texting registration has a carrier fee."
  - `brand` → `BrandInfoSchema`; each issue comes back as field `brand.<field>` with its message (400).
  - `useHostedPolicyPages` and an empty website → `website` = `new URL(policyUrls(...).privacy).origin`.
  - `saveSubmission`; `already_waiting` → 409 "Your registration is already with the phone carriers."
  - audit `texting.registration_submitted` with the brand, EIN masked `**-***6789` (last 4 kept).
  - `deps.jobs.send('texting-registration', { companyId }, { singletonKey: companyId })` → 202 `TextingView`.
- **`advanceRegistration`, stage 1,** inside `withRegistrationLock` (`'busy'` → return):
  - Runs only when `submitted_at` is set, `campaign_status = 'pending'`, and `brand_sid` is null **or** `brand_status = 'failed'` (proposed Ruling AE: a resubmission after a brand failure keeps the failed sid and resubmits it, rather than clearing it). No subaccount yet → `ensureSubaccount` + `saveSubaccount` first (the provision tick may not have run).
  - `registrar.submitBrand(subaccountRef(row, key), { companyId, brand: row.brand_info, statusCallback: PUBLIC_BASE_URL + '/hooks/twilio-registration', previous: { customerProfileSid: row.customer_profile_sid, trustProductSid: row.trust_product_sid, brandSid: row.brand_status === 'failed' ? row.brand_sid : null } })`.
  - Save `customer_profile_sid`, `trust_product_sid`, `brand_sid`, `brand_status 'pending'`.
  - Fee via `withTenant(systemContext)` + `recordUsage`: `texting_registration_fee`, quantity 1, unit `billingConfig(deps).pass_through_cents.brand_registration`, ref `('texting_brand', brandSid)`, description "Texting registration: business check" (a resubmitted brand with the same sid records nothing new).
  - `RegistrarRejectedError` → `campaign_status 'rejected'`, `rejection_reason_plain`/`rejected_fields` from `plainRejection(err.reasonText)`.
  - `RegistrarUnavailableError` → rethrown (the job retries).
  - Then, outside the lock, `continueRegistration(deps, companyId)`.

**Tests:**
- `texting-provision.test.ts`: `test('a new company gets a texting subaccount, once')` — two ticks → one `ensureSubaccount` call in `t.registrar.calls`; the stored token decrypts to `fake-token-<first 8 of id>`; `signingTokenFor(system, id, undefined, key)` returns it. `test("nothing happens when texting isn't set up")` (an app whose registrar is the unconfigured one). `test('canceled companies are skipped')`.
- `texting-submit.test.ts` (a valid brand object for Acme; set `stripe_subscription_id`/`status 'active'` by SQL for "has a card"):
  - `test('submitting needs the owner, a confirmed email and a card')` → 403 ×3 (office, unverified owner, no card) with the exact messages.
  - `test('submit saves, queues and answers waiting')` → 202 `state 'waiting'`; `t.jobs.sent` `toMatchObject([{ name: 'texting-registration', data: { companyId } }])`.
  - `test('a second submit while waiting is refused')` → 409.
  - `test('the job submits the brand and records the fee once')`: drain → `submitBrand` in `t.registrar.calls` with `statusCallback 'https://app.roofline.test/hooks/twilio-registration'`; one `texting_registration_fee` row, unit 4400, "Texting registration: business check"; draining again adds no fee.
  - `test('a refused brand needs a fix')`: `t.registrar.failNext('submitBrand', { rejected: 'EIN does not match' })` → `GET` → `state 'needs_fix'`, `rejectedFields ['legalName','ein']`, the EIN reason.
  - `test('fix and resubmit sends the previous ids')`.
  - `test('the form defaults come from the company')`.
  - `test('a field error names the brand field')`: `ein '12'` → 400 field `brand.ein`.

**Verify notes:**
- api suite needs Docker (none here): locally `npm run typecheck && npm run lint`; prove with `ops/bin/ci-check`.
- Commit: `feat(texting): subaccount at sign-up; submit the registration and send the brand`.

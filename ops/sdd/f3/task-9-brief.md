### Task 9: API skeleton: provider seams, fakes, config, deps, mounts, schedules and job queues

**Base:** `f3-setup` at `baf4c93` or later (F3 Tasks 1–6, 8, 10, 12 and all of `f2-shell` incl. F2 T6–T9 are in). Uses: `parseBillingConfig`/`BillingConfig` from `packages/shared/src/billing.ts` (T3), `BrandInfo`/`CampaignInfo` from `packages/shared/src/texting.ts` (T5), `SmsAdapter`/`FakeSmsAdapter`/`DisabledSmsAdapter` from `@roofline/send-gate` (T8 already gave `OutboundSms` a `sender`), `InlineQueue` in `apps/api/src/tasks/queue.ts` as the model for `InlineJobs`, `ensureStepQueue` in `apps/api/src/tasks/pgboss-queue.ts` as the model for `ensureJobQueues`.
**Parallel hazard:** sibling teams are building T7 (`apps/api/src/imports/{normalize,plan}.ts`) and T11 (`hooks/twilio.ts`, `repos/{delivery,messages,inbound}.ts`, `system/routing.ts`). This task touches none of those files. `imports/run.ts` is new here and is not T7's.

**Split:**
- Builder 1: `apps/api/src/{config,deps,server,index}.ts`, `apps/worker/src/index.ts`, `apps/api/test/helpers.ts`, `.env.example`, the README env table, `apps/api/test/config.test.ts`.
- Builder 2: `apps/api/src/providers/{geocoder,billing,registrar,sms}.ts`, `apps/api/src/providers/fakes/{geocoder,billing,registrar}.ts`, the five real-adapter stubs (`providers/{geocodio,stripe}.ts`, `providers/twilio/{sms,accounts,brands}.ts`), `apps/api/test/fakes.test.ts`.
- Builder 3: `apps/api/src/jobs/{queue,handlers}.ts`, `apps/api/src/jobs/worker.ts`, the route/job/scheduler stubs, `apps/api/src/app.ts` mounts, `apps/api/src/billing/{plans,guards,read-only}.ts`, `eslint.config.js`, `apps/api/test/{jobs,boundaries}.test.ts`.
- Interface contract between builders: Builder 1 imports the four factories and `InlineJobs`/`PgBossJobs`/`ensureJobQueues` by the names below; Builder 3 imports `AppDeps` from `app.ts` (it adds the four fields to `AppDeps` itself, since it owns `app.ts`). The lead joins and runs typecheck.

**Files:**
- Create:
  - `apps/api/src/providers/{geocoder,billing,registrar,sms}.ts`, `apps/api/src/providers/fakes/{geocoder,billing,registrar}.ts`
  - `apps/api/src/jobs/queue.ts`, `apps/api/src/jobs/handlers.ts`
  - `apps/api/src/billing/{plans,guards}.ts`
  - stubs that later tasks fill (each task replaces only its own file):
    - `apps/api/src/providers/{geocodio,stripe}.ts` (T14, T18), `apps/api/src/providers/twilio/{sms,accounts,brands}.ts` (T13, T25, T26)
    - `apps/api/src/imports/run.ts` (T24)
    - `apps/api/src/account/{billing-routes,setup-routes,texting-routes}.ts` (T19, T16, T27), `apps/api/src/account/texting/{advance,progress}.ts` (T27, T28)
    - `apps/api/src/routes/imports.ts` (T23)
    - `apps/api/src/hooks/{stripe,twilio-registration}.ts` (T20, T28)
    - `apps/api/src/public/{policies,policy-urls}.ts` (T17)
    - `apps/api/src/billing/read-only.ts` (T21)
    - `apps/api/src/jobs/scheduler/{end-trials,report-usage,provision-texting,poll-texting,bill-monthly-fees}.ts` (T21, T22, T27, T28, T28)
  - Tests: `apps/api/test/fakes.test.ts`, `apps/api/test/jobs.test.ts`
- Modify: `apps/api/src/{config,deps,app,server,index}.ts`, `apps/api/src/jobs/worker.ts`, `apps/worker/src/index.ts`, `apps/api/test/helpers.ts`, `apps/api/test/boundaries.test.ts`, `apps/api/test/config.test.ts`, `eslint.config.js`, `.env.example`, `README.md` (env table only)
- Do not touch: `package-lock.json`, migrations, `hooks/twilio.ts`, `imports/{parse,mapping,normalize,plan}.ts`, `messaging/**`.

**Interfaces:**
- **Config keys** (in `ConfigSchema`; all optional; blank counts as unset, as `loadConfig` already does):
  - `STRIPE_SECRET_KEY`: must start with `sk_` → "must start with sk_".
  - `STRIPE_WEBHOOK_SECRET`: starts with `whsec_`; required when `STRIPE_SECRET_KEY` is set (`superRefine`, path `STRIPE_WEBHOOK_SECRET`, "is required when STRIPE_SECRET_KEY is set").
  - `BILLING_PLANS_FILE`: a path, resolved from `REPO_ROOT` like `WEB_DIST_DIR` (no existence check here; `billingConfig` reads it). Default outside production: `path.resolve(REPO_ROOT, 'config/billing-plans.example.json')` (apply in the final `.transform`). In production with `STRIPE_SECRET_KEY` set and no file → issue at `BILLING_PLANS_FILE` "is required in production when STRIPE_SECRET_KEY is set". In production without Stripe it stays undefined, so `Config['BILLING_PLANS_FILE']` is `string | undefined`.
  - `GEOCODIO_API_KEY`: string.
  - `TWILIO_ACCOUNT_SID`: `/^AC[0-9a-f]{32}$/` → "must be AC followed by 32 hex digits"; when set, `TWILIO_AUTH_TOKEN` is required (path `TWILIO_AUTH_TOKEN`).
  - `TWILIO_PRIMARY_PROFILE_SID`: `/^BU[0-9a-f]{32}$/`.
  - `POLICY_PAGES_DOMAIN`: a bare lowercase hostname `/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/` (lowercase it first) → "must be a bare hostname, like roofline.app".
  - `FAKE_PROVIDERS`: the existing `flag` helper → boolean | undefined. With `NODE_ENV=production` and the flag true → issue at `FAKE_PROVIDERS` "must not be set in production".
- **Geocoder seam** (`providers/geocoder.ts`):
```ts
export type GeocodeResult = { lng: number; lat: number; street: string | null; city: string | null; state: string | null; zip: string | null;
  timezone: string | null; accuracy: number; accuracyType: string; source: 'geocodio' | 'fake' };
export interface Geocoder { readonly configured: boolean; geocode(address: string): Promise<GeocodeResult | null>;
  geocodeMany(addresses: readonly string[]): Promise<(GeocodeResult | null)[]> }
export class GeocoderUnavailableError extends Error {}
export class UnconfiguredGeocoder implements Geocoder { … }   // configured false; methods throw GeocoderUnavailableError("Address lookup isn't set up.")
export function createGeocoder(config: Config): Geocoder;       // FAKE → new FakeGeocoder(); else geocodioFor(config) ?? new UnconfiguredGeocoder()
```
- **Billing seam** (`providers/billing.ts`):
```ts
export interface BillingProvider { readonly configured: boolean;
  ensureCustomer(i: { companyId: string; name: string; email: string | null; existingCustomerId: string | null }): Promise<{ customerId: string }>;
  createCheckout(i: { customerId: string; companyId: string; planKey: string; priceLookupKeys: string[]; trialEnd: Date | null;
    successUrl: string; cancelUrl: string }): Promise<{ url: string }>;
  createPortal(i: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  changePlan(i: { subscriptionId: string; planKey: string; priceLookupKeys: string[] }): Promise<void>;
  reportMeterEvent(i: { eventName: string; customerId: string; value: number; identifier: string; timestamp: Date }): Promise<void>;
  createInvoiceItem(i: { customerId: string; amountCents: number; description: string; idempotencyKey: string }): Promise<{ invoiceItemId: string }> }
export class BillingUnavailableError extends Error {}
export class UnconfiguredBillingProvider implements BillingProvider { … }   // "Billing isn't set up."
export function createBillingProvider(config: Config): BillingProvider;   // FAKE → FakeBillingProvider; else stripeFor(config) ?? Unconfigured
```
- **Registrar seam** (`providers/registrar.ts`):
```ts
export type SubaccountRef = { accountSid: string; authToken: string };
export type ReviewStatus = 'pending' | 'approved' | 'failed';
export interface TextingAccounts {
  ensureSubaccount(companyId: string): Promise<{ accountSid: string; authToken: string }>;
  ensureMessagingService(sub: SubaccountRef, companyId: string, urls: { inbound: string; status: string }): Promise<{ messagingServiceSid: string }>;
  ensureNumber(sub: SubaccountRef, i: { messagingServiceSid: string; areaCode: string | null; state: string | null }):
    Promise<{ e164: string; phoneNumberSid: string; capabilities: ('sms' | 'voice')[] }> }
export interface TextingBrands {
  submitBrand(sub: SubaccountRef, i: { companyId: string; brand: BrandInfo; statusCallback: string;
    previous: { customerProfileSid: string | null; trustProductSid: string | null; brandSid: string | null } }):
    Promise<{ customerProfileSid: string; trustProductSid: string; brandSid: string }>;
  brandStatus(sub: SubaccountRef, brandSid: string): Promise<{ status: ReviewStatus; failureReason: string | null }>;
  submitCampaign(sub: SubaccountRef, i: { brandSid: string; messagingServiceSid: string; campaign: CampaignInfo; previousCampaignSid: string | null }):
    Promise<{ campaignSid: string }>;
  campaignStatus(sub: SubaccountRef, messagingServiceSid: string, campaignSid: string): Promise<{ status: ReviewStatus; failureReason: string | null }> }
export type TextingRegistrar = TextingAccounts & TextingBrands & { readonly configured: boolean };
export class RegistrarUnavailableError extends Error {}                         // try again later
export class RegistrarRejectedError extends Error { constructor(readonly reasonText: string) { super(reasonText); } }
export function createRegistrar(config: Config): TextingRegistrar;
```
  - `createRegistrar`: FAKE → `new FakeTextingRegistrar()`. Else `accounts = twilioAccountsFor(config) ?? unconfiguredAccounts`, `brands = twilioBrandsFor(config) ?? unconfiguredBrands`, composed into one object (bind methods; do not spread class instances); `configured` = accounts half is real. Unconfigured message: "Texting registration isn't set up."
- **SMS factory** (`providers/sms.ts`): `createSmsAdapter(config: Config): SmsAdapter` — FAKE → `new FakeSmsAdapter()`; else `twilioSmsFor(config) ?? new DisabledSmsAdapter()`.
- **Real-adapter stubs** — each file exports exactly this and returns `null` until its task replaces the file:
  - `providers/geocodio.ts`: `export function geocodioFor(config: Config): Geocoder | null`
  - `providers/stripe.ts`: `export function stripeFor(config: Config): BillingProvider | null`
  - `providers/twilio/sms.ts`: `export function twilioSmsFor(config: Config): SmsAdapter | null`
  - `providers/twilio/accounts.ts`: `export function twilioAccountsFor(config: Config): TextingAccounts | null`
  - `providers/twilio/brands.ts`: `export function twilioBrandsFor(config: Config): TextingBrands | null`
- **Lint note:** typescript-eslint's `no-unused-vars` has no `_` ignore pattern here; a stub that ignores a parameter writes `void config;` (or `void deps;`) in its body.
- **Fakes** (deterministic; each records `calls: { method: string; args: unknown[] }[]` and has `failNext(n = 1)`, which makes the next n calls throw the Unavailable error):
  - **`FakeGeocoder`** (`fakes/geocoder.ts`): `configured = true`.
    - `/nowhere/i` → `null`; `/outage/i` → throws `GeocoderUnavailableError`.
    - Else parses `street, city, ST zip`: `street` = first comma part (trimmed), `city` = second, `state`/`zip` from the last part `/\b([A-Za-z]{2})\s+(\d{5})\b/` (state uppercased); missing parts → null.
    - Position: `h` = FNV-1a 32-bit (offset `0x811c9dc5`, prime `0x01000193`, `Math.imul`, `>>> 0`) of the lowercased, trimmed text; `lng = -95.9345 + (h % 1000) / 20000`, `lat = 41.2565 + (Math.floor(h / 1000) % 1000) / 20000`, both rounded to 6 decimals.
    - `timezone` by state: NE IA KS MO TX → `America/Chicago`; NY FL GA OH MA → `America/New_York`; CO → `America/Denver`; AZ → `America/Phoenix`; CA WA → `America/Los_Angeles`; else `America/Chicago`.
    - `accuracy: 1`, `accuracyType: 'rooftop'`, `source: 'fake'`.
    - `geocodeMany` records each batch in `batches: string[][]`; inside a batch a `/outage/i` (or `/nowhere/i`) address gives `null` for that item only; `failNext` makes the whole batch call throw.
  - **`FakeBillingProvider`** (`fakes/billing.ts`): `configured = true`.
    - `ensureCustomer`: `existingCustomerId` when given; else the same `companyId` always gets the same id; new ids `cus_fake_<n>` (n from 1).
    - `createCheckout` → `{ url: 'https://checkout.stripe.test/c/cs_fake_<n>' }`, input recorded in `checkouts`.
    - `createPortal` → `{ url: 'https://billing.stripe.test/p/bps_fake_<n>' }`, recorded in `portals`.
    - `changePlan` recorded in `planChanges`.
    - `reportMeterEvent` recorded in `meterEvents`, ignoring an `identifier` already seen.
    - `createInvoiceItem` returns the same `ii_fake_<n>` for the same `idempotencyKey` and records it once in `invoiceItems`.
  - **`FakeTextingRegistrar`** (`fakes/registrar.ts`): `configured = true`.
    - `fakeSid(prefix, seed)` = prefix + first 32 hex chars of `sha256(seed)` (export it).
    - `ensureSubaccount(companyId)` → `{ accountSid: fakeSid('AC', companyId), authToken: 'fake-token-' + companyId.slice(0, 8) }`
    - `ensureMessagingService` → `{ messagingServiceSid: fakeSid('MG', companyId) }`
    - `ensureNumber` → `{ e164: '+1' + (areaCode ?? '402') + '5550100', phoneNumberSid: fakeSid('PN', messagingServiceSid), capabilities: ['sms','voice'] }`, the same on repeat
    - `submitBrand` → `{ customerProfileSid: fakeSid('BU', 'cp:' + companyId), trustProductSid: fakeSid('BU', 'tp:' + companyId), brandSid: fakeSid('BN', companyId) }`
    - `submitCampaign` → `{ campaignSid: fakeSid('QE', brandSid) }`
    - `brandStatus`/`campaignStatus` start `{ status: 'pending', failureReason: null }`; `setBrand(status, reason?)`, `setCampaign(status, reason?)` change them.
    - `failNext(method: keyof TextingAccounts | keyof TextingBrands, what: 'unavailable' | { rejected: string })`: the next call of that method throws `RegistrarUnavailableError` or `new RegistrarRejectedError(rejected)`. (This replaces the generic `failNext(n)` for the registrar.)
- **Jobs** (`jobs/queue.ts`, `jobs/handlers.ts`):
```ts
export const JOB_NAMES = ['import-customers', 'texting-registration'] as const; export type JobName = (typeof JOB_NAMES)[number];
export type JobData = { companyId: string; importId?: string };
export type JobMeta = { attempt: number; lastAttempt: boolean };
export interface JobQueue { send(name: JobName, data: JobData, opts?: { singletonKey?: string }): Promise<void> }
export const JOB_QUEUE_OPTIONS = { policy: 'stately', retryLimit: 4, retryBackoff: true, retryDelay: 30 } as const;   // 5 attempts
export class PgBossJobs implements JobQueue { constructor(boss: PgBoss) }   // boss.send(name, data, opts ?? {})
export async function ensureJobQueues(boss: PgBoss): Promise<void>;          // createQueue each name with JOB_QUEUE_OPTIONS; throw if an existing queue has another policy (as ensureStepQueue does)
export class InlineJobs implements JobQueue { readonly sent: { name: JobName; data: JobData; singletonKey?: string }[]; readonly errors: unknown[];
  drain(deps: AppDeps): Promise<void> }
// handlers.ts
export const JOB_HANDLERS: Record<JobName, (deps: AppDeps, data: JobData, meta: JobMeta) => Promise<void>>;
// 'import-customers' → runImport(deps, data.companyId, data.importId!, meta); 'texting-registration' → advanceRegistration(deps, data.companyId)
```
  - `InlineJobs.send` records every call in `sent`; it drops (does not queue) a send whose `singletonKey` matches a job still pending. `drain` runs pending jobs in order (including ones sent while draining) through `JOB_HANDLERS`, with `attempt` 1..5; every throw is pushed to `errors` (T24's crash test expects `errors.length === 1` after one failed attempt), and the job is re-queued with `attempt + 1` until attempt 5 (`lastAttempt: true` on the 5th); after a throw on the 5th it is dropped. Same `maxRuns` safety as `InlineQueue` (default 100).
- **`AppDeps` gains** `geocoder: Geocoder; billing: BillingProvider; registrar: TextingRegistrar; jobs: JobQueue` (with doc comments like the existing fields).
- **`buildDeps(config, queue, jobs: JobQueue)`** uses the four factories (`createGeocoder`, `createBillingProvider`, `createRegistrar`, `createSmsAdapter` — the latter replaces the hard-coded `new DisabledSmsAdapter()`).
- **`server.ts` and `apps/worker/src/index.ts`**: after `ensureStepQueue(boss)`, `await ensureJobQueues(boss)`, then `buildDeps(config, new PgBossQueue(boss), new PgBossJobs(boss))`. The worker log line also names the job queues.
- **`startWorker`** (`jobs/worker.ts`): after the step queue, `ensureJobQueues(boss)`; for each `JOB_NAMES` name, `boss.work(name, { ...polling, includeMetadata: true }, async ([job]) => …)` with `meta = { attempt: job.retryCount + 1, lastAttempt: job.retryCount >= job.retryLimit }`; a job whose `data.companyId` is not a UUID is reported (`reportJobError`) and dropped; a throw becomes `JobFailed`.
- **`SCHEDULES` gains** (in this order, after the three existing): `end-trials` `*/5 * * * *` → `endTrials`; `report-usage` `* * * * *` → `reportUsage`; `provision-texting` `* * * * *` → `provisionTexting`; `poll-texting` `0 * * * *` → `pollTexting`; `bill-monthly-fees` `0 9 1 * *` → `billMonthlyFees`.
- **`billing/plans.ts`:** `billingConfig(deps: AppDeps): BillingConfig` — reads `deps.config.BILLING_PLANS_FILE` once per path (module-level `Map<string, BillingConfig>`) through `parseBillingConfig`; a missing setting, missing file or invalid file throws (`BillingConfigError` for invalid content, an `Error` "BILLING_PLANS_FILE is not set" otherwise).
- **`billing/guards.ts`:** `hasPaymentMethod(f: { stripeSubscriptionId: string | null; status: CompanyStatus }): boolean` — true when there is a subscription and the status is `active` or `past_due`.
- **Scheduler stubs** — each `(deps: AppDeps, now: Date) => Promise<void>` that does nothing: `endTrials` (`end-trials.ts`), `reportUsage` (`report-usage.ts`), `provisionTexting` (`provision-texting.ts`), `pollTexting` (`poll-texting.ts`), `billMonthlyFees` (`bill-monthly-fees.ts`).
- **Route stubs** — each `(deps: AppDeps) => Router` returning an empty `Router()`: `billingRoutes` (`account/billing-routes.ts`), `setupRoutes` (`account/setup-routes.ts`), `textingRoutes` (`account/texting-routes.ts`), `importRoutes` (`routes/imports.ts`), `stripeHooks` (`hooks/stripe.ts`; its router already does `router.use(express.raw({ type: '*/*', limit: '512kb' }))`), `twilioRegistrationHooks` (`hooks/twilio-registration.ts`), `policyPages` (`public/policies.ts`). `public/policy-urls.ts`: `export function policyUrls(config: Config, slug: string): { privacy: string; terms: string }` returning `${PUBLIC_BASE_URL}/policies/${slug}/privacy|terms` (T17 refines). `readOnlyGuard: RequestHandler` (`billing/read-only.ts`) calls `next()`.
- **Job stubs:** `runImport(deps, companyId, importId, meta)` (`imports/run.ts`), `advanceRegistration(deps, companyId)` (`account/texting/advance.ts`), `continueRegistration(deps, companyId)` (`account/texting/progress.ts`) — all resolve doing nothing.
- **Mounts in `createApp`:**
  - right after `helmet`: `app.use(policyPages(deps))` (before `/health`)
  - before the JSON parser and beside `/hooks/twilio`: `app.use('/hooks/stripe', stripeHooks(deps))` and `app.use('/hooks/twilio-registration', twilioRegistrationHooks(deps))`
  - right after `app.use('/api', attachSession(deps), apiRateLimit(config), requireSession)`: `app.use('/api', readOnlyGuard)`
  - routers, after `/api/weather`: `/api/billing` → `billingRoutes(deps)`, `/api/setup` → `setupRoutes(deps)`, `/api/imports` → `importRoutes(deps)`, `/api/texting` → `textingRoutes(deps)`
- **`index.ts` exports** add: `createGeocoder`, `createBillingProvider`, `createRegistrar`, `createSmsAdapter`, the seam types and error classes, `JOB_NAMES`, `PgBossJobs`, `ensureJobQueues`, `InlineJobs`, types `JobQueue`, `JobName`, `JobData`. Update the `buildDeps` export (signature).
- **ESLint:** `DB_SYSTEM_ALLOWED` gains `'apps/api/src/account/**'` and `'apps/api/src/public/**'`; `DB_SYSTEM_PATTERN.message` becomes `Only auth, the Twilio and Stripe hooks, the scheduler jobs, account and public routes, scripts, the worker and the db package may import @roofline/db/system. Use withTenant from @roofline/db instead.`
- **`TestApp` gains** `geocoder: FakeGeocoder; billing: FakeBillingProvider; registrar: FakeTextingRegistrar; jobs: InlineJobs`, wired into `deps` by `makeTestApp`.
- **`testConfig` adds** `STRIPE_WEBHOOK_SECRET: 'whsec_test_roofline'`, `BILLING_PLANS_FILE: <repo>/config/billing-plans.example.json` (absolute, `fileURLToPath(new URL('../../../config/billing-plans.example.json', import.meta.url))`) and `POLICY_PAGES_DOMAIN: 'roofline.test'`. It does **not** set `FAKE_PROVIDERS` (tests pass the fakes directly).
- **`.env.example` / README table:** one entry each for the seven new keys, placeholders only (`STRIPE_SECRET_KEY=`, `FAKE_PROVIDERS=` with the "development and test only; refused in production" note, `BILLING_PLANS_FILE=` "defaults to config/billing-plans.example.json outside production").

**Tests:**
- `config.test.ts` (extend): `STRIPE_SECRET_KEY='sk_test_x'` without a webhook secret → `ConfigError` whose message names `STRIPE_WEBHOOK_SECRET`; `TWILIO_ACCOUNT_SID='ACxyz'` → names `TWILIO_ACCOUNT_SID`; `FAKE_PROVIDERS=1` with `NODE_ENV=production` → names `FAKE_PROVIDERS`; `BILLING_PLANS_FILE` defaults to a path ending `config/billing-plans.example.json` in development; `buildDeps(loadConfig({...base, FAKE_PROVIDERS: '1'}), new InlineQueue(), new InlineJobs())` gives `FakeGeocoder`, `FakeBillingProvider`, `FakeTextingRegistrar`, `FakeSmsAdapter` (`instanceof`); without it `deps.geocoder.configured`, `deps.billing.configured`, `deps.registrar.configured` are all false and `deps.sms` is a `DisabledSmsAdapter`. End the deps' pools in `finally`.
- `fakes.test.ts`: one test per fake behaviour above, including `FakeGeocoder.geocode('1200 Farnam St, Omaha, NE 68102')` → `toMatchObject({ street: '1200 Farnam St', city: 'Omaha', state: 'NE', zip: '68102', timezone: 'America/Chicago' })` and the same `lng`/`lat` on a second call; `geocodeMany(['1 A St, Omaha, NE 68102', 'outage', '2 B St, Omaha, NE 68102'])` → `[obj, null, obj]` and one entry in `batches`; billing `createInvoiceItem` twice with one key → same id, one record; registrar `failNext('submitBrand', { rejected: 'EIN mismatch' })` → the next `submitBrand` throws `RegistrarRejectedError` with `reasonText 'EIN mismatch'`, the one after succeeds; each unconfigured adapter throws its Unavailable error with `<Service> isn't set up.`
- `jobs.test.ts`: `InlineJobs` drops a second send with the same pending `singletonKey` (`sent` has 2, one job runs); a handler (swap `JOB_HANDLERS['import-customers']` with `vi.spyOn` or pass a handler map to a `drain(deps, handlers?)` overload) that throws twice then succeeds runs 3 times with attempts 1,2,3 and `lastAttempt` false; one that always throws runs 5 times, `lastAttempt` true only on attempt 5, and `errors.length === 5`; `SCHEDULES` has the five new names with the exact crons.
- `boundaries.test.ts`: add `apps/api/src/account/__fixture_ok_import.ts` and `apps/api/src/public/__fixture_ok_import.ts` to the "may import it" list and `apps/api/src/routes/imports.ts` to the "may not" list.

**Verify notes:**
- No Docker here, so the `@roofline/api` project (its `globalSetup` starts PostGIS) cannot run locally. Locally: `npm run typecheck && npm run lint`. Prove the tests with `ops/bin/ci-check` (Platform job runs every suite).
- Every existing `buildDeps(config, queue)` caller must be updated (grep `buildDeps(`): `server.ts`, `apps/worker/src/index.ts`, `config.test.ts`, anything in `apps/api/src/scripts/`.
- Commit: `feat(api): F3 provider seams with fakes, config, job queues, schedules and route skeleton`.

# Roofline Estimator and Homeowner Page (E1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. In this repo the team script runs each task with one Sonnet lead and up to three Haiku builders on the **Split** packages.

**Goal:** From a typed address to a signed Good/Better/Best proposal: building outline from footprints on satellite imagery, an instant estimate (optional EagleView aerial measure), EagleView exact reports on demand (owner-approved spend, re-billed), three priced options from tier templates with a financing estimate, an Estimator agent draft sent by text through the send gate after one approval, and a phone-first public homeowner page with built-in e-sign, a tamper-evident signed PDF and the job moved to Won.

**Architecture:**
- **Skeletons first:** Task 1 (schema, migrations, npm dependencies, placeholders, barrels), Task 5 (API seams with fakes — `FootprintSource`, `AerialMeasure`, `ExactReports`, `ObjectStore` — config, job names, schedules, step handler registration, route stubs and mounts, the public route prefix), Task 16 (web routes, the public `/p/:token` route outside the shell, dock flag, Settings sections, copy files).
- **Pure math in `@roofline/shared`:** roof geometry and the instant estimate (`roof.ts`), tiers and financing (`tiers.ts`), proposal and signature types and canonical JSON (`proposals.ts`), the two new step types in `steps.ts`.
- **Paid providers behind seams with deterministic fakes** (F3 Ruling 29): `FAKE_PROVIDERS=1` swaps every one; real adapters are tested against recorded JSON through an injected `fetch`.
- **The public homeowner API** lives in `apps/api/src/public/` (allowed to use `app_system` to resolve a token to a company), then runs in that company's `app_tenant` transaction.

**Tech Stack:** as C1. New: `yauzl` (streaming unzip) and `stream-json` (streaming GeoJSON) for footprint loading; `aws4fetch` (SigV4 for R2 over `fetch`). EagleView over plain `fetch` (no SDK), ported from `v1/server/{providers,eagleview-sandbox,jobs}.ts`.

**Spec:** `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md` (decisions numbered there). Parents: master §1, §3, §8 row 3, §9, §12–14; Foundation F1–F3; Core CRM C1 (pricebook, quotes, PDF renderer, job window).

**Branch:** integration branch `e1-estimator` from `c1-crm` once C1 is merged; task branches `e1-t<N>`.

---

## Global Constraints

- **Everything in C1's Global Constraints applies** (TypeScript/ESM, enum columns with `enumCheck`, tenant tables with forced RLS and composite FKs, `app_system` column grants plus `app_system_all`, no raw queries from routes, `{error, field?}` errors with messages as module constants, secrets only from `config.ts`, copy rules, feature hooks in `features/<feature>/api.ts`, no third-party UI library, 12px / AA / 40px / 375px rules, company time zone for dates).
- **`@roofline/db/system`** is allowed in `apps/api/src/public/**` (F3 Ruling 4) — the homeowner API uses it only to resolve a token hash to `{companyId, proposalId}`; and in `apps/api/src/jobs/scheduler/**` for the footprint and EagleView fan-outs.
- **Global footprint tables** (`building_footprints`, `building_footprint_states`) carry no tenant data: `app_tenant` gets SELECT on `building_footprints` only; writes are `app_system` from the loader job.
- **Money:** integer cents everywhere; the pricing engine's output is frozen per option; homeowners never see unit prices (spec Decision 15).
- **"Estimate"** labels every instant number and every price derived from one, in the app, the PDF and the homeowner page (master §9.2).
- **Provider text** (EagleView, R2, Microsoft download errors) is never stored or shown; keep status codes and our own plain messages.
- **Lockfile:** only Task 1 edits `package-lock.json`. **Migrations:** only Task 1 (0014 generated, 0015 custom) — C1 used 0012/0013.
- **Public page:** no session, no third-party scripts, `noindex`, `Referrer-Policy: no-referrer`, rate limits per IP and per token, and the token is never logged (log `token_hash` prefix only).

## Review Focus

1. **A link opens exactly one company's proposal.** No token guessing (32 random bytes), constant-time comparison through the hash index, no other customer data on the page, another company's data never reachable. (Tasks 11, 12)
2. **What was signed can be proven.** The `document_sha256` covers the option as shown; the PDF hash is stored; nothing edits a signed proposal; a resend never changes the link of a signed proposal. (Tasks 4, 12, 13)
3. **Money approved once.** The EagleView order is claimed before the call, an uncertain result is never retried, the usage event is recorded once per report, and the max spend shown in R2 bounds the order. (Tasks 9, 10)
4. **Prices that don't drift.** A sent proposal never re-prices; an exact report on a sent proposal creates a revised draft. (Tasks 8, 10)
5. **Geometry edge cases.** Outlines across the antimeridian don't occur in the US, but self-intersecting edits, 3-corner outlines, very large outlines (warehouses) and points with no footprint must all give plain results, not 500s. (Tasks 2, 7)

---

## Parallel lanes

| Task | Depends on (E1) | Notes |
|---|---|---|
| 1 Schema, migrations, dependencies, skeleton | — | only lockfile and migration edits |
| 2 Shared roof geometry and the instant estimate | 1 | |
| 3 Shared tiers and financing | 1 | |
| 4 Shared proposal types, signature record, canonical JSON, step types | 1 | `shared/steps.ts` |
| 5 API skeleton: seams, fakes, config, jobs, schedules, mounts | 1, 4 | only `app.ts`/`config.ts`/`deps.ts`/`test/helpers.ts`/`jobs/*` edits |
| 6 Footprints: loader job and lookup | 5 | |
| 7 Measurements API | 2, 5, 6 | |
| 8 Tier templates, estimator settings, proposals API and PDF | 3, 4, 5 | |
| 9 EagleView adapters (orders, reports, Property Data) | 5 | |
| 10 Exact report flow and aerial measure | 7, 8, 9 | |
| 11 Sending: the Estimator agent's step and the link | 4, 8 | `messaging/send-batch.ts` export only |
| 12 Public homeowner API and e-sign | 4, 8, 11 | `apps/api/src/public/proposals*.ts` |
| 13 Signed PDF and object storage (R2 adapter) | 5, 12 | |
| 14 Web skeleton | 4 | only `router.tsx`/`apps.ts`/`Settings` edits |
| 15 Web: Estimator window and the address flow | 14 | |
| 16 Web: measure view with the outline editor | 2, 14 | |
| 17 Web: proposal view and editing | 3, 14 | |
| 18 Web: Settings — templates, financing, estimates | 3, 14 | |
| 19 Web: homeowner page and e-sign | 4, 14 | |
| 20 Web: job window proposals, R2 previews, Today/Estimator badges | 14 | |
| 21 End-to-end, acceptance map, docs | 6–20 | |
| 22 Manual smoke: EagleView sandbox, R2, a real text | 9, 10, 13 | |

**Waves (proposed team groups of three):**
- **Wave 1:** T1.
- **Wave 2:** G1 = T2, T3, T4.
- **Wave 3:** G2 = T5, T14 (API and web skeletons).
- **Wave 4:** G3 = T6, T8, T9 · G4 = T15, T16, T18 · G5 = T17, T19, T20.
- **Wave 5:** G6 = T7, T11 · then G7 = T10, T12 · then T13.
- **Wave 6:** T21; T22 by hand.

**Shared files:** barrels get every E1 line in Task 1; `shared/steps.ts` only in Task 4; `messaging/send-batch.ts` only in Task 11 (one export added); `features/job/JobSections.tsx` (C1) only in Task 20; `quotes/pdf.ts` (C1) is imported, not edited — Task 8 adds `proposals/pdf.ts`.

---

## File structure

```
packages/db/migrations/0014_estimator_schema.sql 0015_estimator_grants_rls.sql          T1
packages/db/src/schema/{global,tenant}.ts                                               T1
packages/db/src/repos/ measurements.ts (T7) tier-templates.ts proposals.ts (T8) proposal-public.ts (T12) exact-reports.ts (T10) stored-files.ts (T13)
packages/db/src/system/ footprints.ts (T6) proposal-links.ts (T12) exact-report-fanout.ts (T10)
packages/shared/src/ roof.ts (T2) tiers.ts (T3) proposals.ts (T4) steps.ts (T4 edits)
apps/api/src/providers/ footprints.ts aerial.ts exact-reports.ts object-store.ts fakes/{footprints,aerial,exact-reports,object-store}.ts (T5)
                        ms-footprints.ts (T6) eagleview/{http,orders,property-data,normalize}.ts (T9) r2.ts (T13)
apps/api/src/estimator/ measure.ts (T7) build.ts reprice.ts (T8) exact-report.ts (T10) send-proposal.ts (T11) signed-pdf.ts (T13)
apps/api/src/proposals/pdf.ts (T8)   apps/api/src/public/{proposals,proposal-sign}.ts (T12)
apps/api/src/routes/ measurements.ts (T7) tier-templates.ts estimator-settings.ts proposals.ts (T8)
apps/api/src/jobs/scheduler/{footprints-ensure,exact-report-poll}.ts (T6, T10)
apps/web/src/features/ estimator/ (T15) measure/ (T16) proposals/ (T17) homeowner/ (T19) settings/{TiersSection,FinancingSection,EstimateSection}.tsx (T18)
apps/web/src/copy/ estimator.ts measure.ts proposals.ts homeowner.ts tiers.ts (new), legal.ts (footprint attribution)
apps/web/e2e/ estimator.spec.ts homeowner.spec.ts (T21)
docs/superpowers/ e1-acceptance.md e1-manual-smoke.md (T21, T22)
```

---

### Task 1: Dependencies, E1 schema and the module skeleton

**Split:** Builder 1 schema TS + `0014`; Builder 2 `0015` grants/RLS + `rls.test.ts`/`migrations.test.ts`; Builder 3 npm dependencies, placeholders, barrels, shared enum constants.

**Files:**
- Modify: `packages/db/src/schema/{global,tenant,enums}.ts`, `packages/db/src/{index,system/index}.ts`, `packages/shared/src/index.ts`, `apps/api/package.json`, `package-lock.json`
- Create: `packages/db/migrations/0014_estimator_schema.sql` (generated), `0015_estimator_grants_rls.sql` (custom), meta; placeholders (`export {};`): `packages/db/src/repos/{measurements,tier-templates,proposals,proposal-public,exact-reports,stored-files}.ts`, `packages/db/src/system/{footprints,proposal-links,exact-report-fanout}.ts`, `packages/shared/src/{roof,tiers,proposals}.ts`
- Test: `packages/db/test/{migrations,rls}.test.ts` (extend)

**Interfaces:**
- **npm (`apps/api`):** `yauzl`, `stream-json`, `aws4fetch` (+ `@types/yauzl`, `@types/stream-json` dev).
- **Shared constants** (in `packages/shared/src/proposals.ts`, written now; Task 4 adds the rest below): `MEASUREMENT_KINDS = ['estimate','exact'] as const`, `MEASUREMENT_METHODS = ['outline','aerial','eagleview','manual'] as const`, `TIERS = ['good','better','best'] as const`, `ADD_ON_UNITS = ['per_square','per_edge_ft','per_ridge_ft','per_valley_ft','per_job'] as const`, `PROPOSAL_STATUSES = ['draft','ready','sent','viewed','signed','declined','expired','replaced'] as const`, `PROPOSAL_EVENT_KINDS = ['sent','viewed','option_viewed','signed','declined','link_resent','link_copied'] as const`, `EXACT_ORDER_STATUSES = ['priced','ordering','waiting','complete','attention','canceled'] as const`, `FOOTPRINT_STATE_STATUSES = ['loading','ready','failed'] as const`, `STORED_FILE_KINDS = ['signed_proposal_pdf'] as const`, and types.
- **Global tables:** `building_footprints` (`id bigserial pk`, `state char(2) not null`, `geom geometry(Polygon,4326) not null` GIST, `area_sq_ft numeric(12,1) not null`, `source text not null`, `source_ref text`; index `(state)`), `building_footprint_states` (`state char(2) pk`, `status` CHECK, `buildings integer`, `source_url text`, `started_at`, `loaded_at`, `error_plain`).
- **Tenant tables** (company_id, timestamps, `unique (company_id, id)`, composite FKs, in `TENANT_TABLES`) — columns exactly as spec §3.4, §4.1, §4.3, §5.3, §8: `measurements`, `tier_templates` (unique `(company_id, tier)`), `proposals` (unique `(company_id, number)`, unique `link_token_hash`), `proposal_counters` (`company_id` unique, `next_number`), `proposal_options` (unique `(proposal_id, tier)`), `proposal_signatures` (unique `proposal_id`), `proposal_events` (index `(proposal_id, at)`), `exact_report_orders` (unique `(company_id, reference_id)`), `stored_files`.
- **`company_settings` gains** `default_pitch_x12 numeric(4,2) not null default 6` (CHECK 0–24), `overhang_ft numeric(3,1) not null default 1` (0–3), `proposal_valid_days integer not null default 30` (1–180), `aerial_measure boolean not null default false`, `estimate_change_clause boolean not null default true`.
- **`0015`:** tenant grants (SELECT/INSERT/UPDATE on the nine tables; no DELETE except none), RLS blocks; `GRANT SELECT ON building_footprints TO app_tenant`; `GRANT ALL ON building_footprints, building_footprint_states TO app_system`; column-level `GRANT SELECT (id, company_id, link_token_hash, status, valid_until) ON proposals TO app_system` + `app_system_all` on `proposals`; `GRANT SELECT (id, company_id, status, last_polled_at) ON exact_report_orders TO app_system` + `app_system_all`; tenant UPDATE grants on the new `company_settings` columns.
- [ ] **Tests:** the nine tables are tenant tables with RLS forced; `proposals.link_token_hash` unique across companies (23505); `tier_templates` one per tier per company; `building_footprints` readable by `app_tenant` with any `app.company_id`, not writable; the extended grant lists.
- [ ] **Verify:** db suite on CI (`ops/bin/ci-check`); typecheck, lint locally.
- [ ] **Commit:** `feat(db): E1 schema (footprints, measurements, tiers, proposals, signatures, exact reports) and skeleton`

---

### Task 2: Shared roof geometry and the instant estimate

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
- [ ] **Tests:** a 40 ft × 30 ft rectangle at Omaha's latitude → footprint 1,200 ± 0.5%; perimeter 140 ± 0.5%; 6/12 → factor 1.1180; overhang 1 → plan 1,340, surface ≈ 1,498.1, edges 148, ridge 40; an L-shape fixture; two rings sum; problems (2 corners, a bow-tie, a warehouse).
- [ ] **Verify:** `npx vitest run --project @roofline/shared roof`.
- [ ] **Commit:** `feat(shared): roof outline geometry and the instant estimate`

---

### Task 3: Shared tiers and financing

**Split:** Builder 1 `TierTemplate` schema and `DEFAULT_TIER_TEMPLATES`; Builder 2 `priceTier` and `addOnQuantity`; Builder 3 `monthlyPaymentCents` and the tests.

**Files:** Modify `packages/shared/src/tiers.ts`; Test `packages/shared/test/tiers.test.ts`.

**Interfaces:**
```ts
export type AddOn = { name: string; unit: AddOnUnit; rateCents: number; taxable: boolean };
export type TierTemplate = { tier: Tier; name: string; material: Scope['material']; wastePercent: number; markupPercent: number | null; addOns: AddOn[]; highlights: string[]; enabled: boolean };
export const TierTemplateSchema: z.ZodType<TierTemplate>;       // name 1–60; ≤ 8 add-ons; rate 0–1,000,000 cents; ≤ 4 highlights of ≤ 60 chars
export const DEFAULT_TIER_TEMPLATES: readonly TierTemplate[];   // spec Decision 10, exact names, rates and highlights
export type MeasuredQuantities = { squares: number; edgeFt: number; ridgeFt: number; valleyFt: number };
export function addOnQuantity(unit: AddOnUnit, q: MeasuredQuantities): number;   // per_square → squares (× (1 + waste)) ; per_edge_ft → edgeFt ; per_ridge_ft → ridgeFt ; per_valley_ft → valleyFt ; per_job → 1
export type TierPrice = { scope: Scope; calculation: Calculation; addOnLines: QuoteLine[]; totalCents: number };
export function priceTier(t: TierTemplate, base: Omit<Scope, 'material' | 'wastePercent' | 'markupPercent'> & { markupPercent: number }, prices: Pricebook, q: MeasuredQuantities): TierPrice;
export function monthlyPaymentCents(principalCents: number, aprBps: number, months: number): number;   // amortized, rounded up to the cent; aprBps 0 → ceil(P/n)
```
- **`priceTier`:** `calculateQuote({ ...base, material: t.material, wastePercent: t.wastePercent, markupPercent: t.markupPercent ?? base.markupPercent }, prices)`, then add-on lines `{ code: 'addon:<n>', name, quantity, unit, unitCents, totalCents, taxable }`; `totalCents = calc.totalCents + Σ addOn.totalCents × (1 + markup) + tax on taxable add-ons` — implemented by recomputing subtotal, markup and tax over **all** lines with v1's rounding rules (write it as `withAddOns(calc, lines, markupPercent, taxPercent)` and test it equals `calculateQuote` when there are no add-ons).
- [ ] **Tests:** the three defaults parse; Good on v1's default scope equals `calculateQuote` exactly; Better adds the two add-on lines with the expected quantities; taxable add-ons are taxed, non-taxable not; `monthlyPaymentCents(1_425_000, 999, 120)` = the amortization value (compute in the test with the formula, assert equality); 0% APR; invalid templates refused with paths.
- [ ] **Verify:** `npx vitest run --project @roofline/shared tiers`.
- [ ] **Commit:** `feat(shared): Good/Better/Best templates, add-ons and the financing estimate`

---

### Task 4: Shared proposal types, signature record, canonical JSON, step types

**Split:** Builder 1 view types in `proposals.ts`; Builder 2 `canonicalJson` and `SignatureRecord`; Builder 3 the two step types in `steps.ts` and tests.

**Files:** Modify `packages/shared/src/proposals.ts`, `packages/shared/src/steps.ts`; Test `packages/shared/test/{proposals,steps-e1}.test.ts`.

**Interfaces:**
```ts
export type MeasurementView = { id: string; propertyId: string; jobId: string | null; kind: MeasurementKind; method: MeasurementMethod;
  outline: Outline | null; structures: { footprintId: string; included: boolean; areaSqFt: number }[]; estimate: InstantEstimate; facets: number | null;
  locked: boolean; providerRef: string | null; notes: string | null; createdAt: string; drawMode: boolean };
export type ProposalOptionView = { id: string; tier: Tier; name: string; highlights: string[]; scope: Scope; addOns: AddOn[]; calculation: Calculation;
  addOnLines: QuoteLine[]; totalCents: number; monthlyEstimateCents: number | null; enabled: boolean };
export type ProposalView = { id: string; number: string; status: ProposalStatus; jobId: string; customer: { id: string; name: string; phone: string | null };
  address: string; measurementId: string; basis: MeasurementKind; options: ProposalOptionView[]; messageBody: string; validUntil: string;
  sentAt: string | null; views: { count: number; first: string | null; last: string | null }; signed: { optionId: string; name: string; at: string } | null;
  declined: { reason: string | null; at: string } | null; taskId: string | null; replacedById: string | null; canEdit: boolean };
export type PublicProposalView = { companyName: string; companyPhone: string | null; firstName: string | null; address: string; validUntil: string;
  status: 'open' | 'signed' | 'declined' | 'expired'; basis: MeasurementKind; options: { id: string; tier: Tier; name: string; highlights: string[];
  inclusions: string[]; totalCents: number; monthlyEstimateCents: number | null; financingTerms: { aprBps: number; months: number } | null }[];
  signed: { optionId: string; name: string; at: string; pdfReady: boolean } | null; estimateClause: boolean };
export const CONSENT_TEXT_V1 = 'I agree to sign electronically and to receive this agreement electronically. I can ask for a paper copy.';
export const ESTIMATE_CLAUSE_V1 = "This price is based on an estimate of your roof's size. If the measured size differs, we'll show you the updated price and ask you to confirm before work starts.";
export type SignatureRecord = { optionId: string; signerName: string; typedSignature: string; drawnSignaturePngSha256: string | null; consentText: string;
  consentVersion: 'v1'; documentSha256: string; totalCents: number; ip: string; userAgent: string; signedAt: string; viewedFirstAt: string | null };
export function canonicalJson(value: unknown): string;   // sorted keys, no whitespace, numbers as JSON; arrays keep order; undefined dropped
export function signedDocument(p: PublicProposalView, optionId: string, clause: boolean): unknown;   // what document_sha256 covers: company, address, the chosen option as shown, valid until, clause text when on
```
(`CONSENT_TEXT_V1`/`ESTIMATE_CLAUSE_V1` are legal record text, stored verbatim with the signature; the web shows them from `copy/homeowner.ts` with the same words — a test asserts equality.)
- **Step types (`steps.ts`):** `STEP_TYPES` gains `'send_proposal'` (approvalClass `message`; payload `{ proposalId: uuid, customerId: uuid, body: string (1–640, must contain '{link}'), basis: MeasurementKind, totals: number[] }`; validate: `{link}` present → else "Keep {link} in the message so they can open the proposal."; preview `{ title: 'Text the proposal to <first name>', lines: ['Good $11,900 · Better $14,250 · Best $17,600', basis line], messageSample: body with a sample link, recipientCount: 1 }`; minutesSaved 20) and `'order_exact_report'` (approvalClass `spend`; payload `{ orderId: uuid, measurementId: uuid, address: string, maxSpendCents: int }`; preview `{ title: 'Order an exact roof report', lines: [address], maxSpendCents }`; minutesSaved 10). Shared formatting of dollars inside previews uses the existing step-preview helpers.
- [ ] **Tests:** `canonicalJson` key order and stability; `signedDocument` changes when the option total changes; the two step payloads validate and preview; `{link}` rule; copy-rules (`npx vitest run --project @roofline/web copy-rules`).
- [ ] **Commit:** `feat(shared): proposal views, the signature record and the proposal and exact-report steps`

---

### Task 5: API skeleton: seams, fakes, config, jobs, schedules, mounts

**Split:** Builder 1 config, deps, test helpers, env docs; Builder 2 the four seams and fakes + `estimator-fakes.test.ts`; Builder 3 job names, schedules, step handler registration (stubs), route stubs and mounts, public prefix in `middleware.ts`.

**Files:**
- Create: `apps/api/src/providers/{footprints,aerial,exact-reports,object-store}.ts`, `apps/api/src/providers/fakes/{footprints,aerial,exact-reports,object-store}.ts`, stubs `apps/api/src/providers/ms-footprints.ts` (`msFootprintsFor(config): FootprintSource | null`), `apps/api/src/providers/eagleview/{orders,property-data}.ts` (`eagleViewOrdersFor`, `eagleViewPropertyDataFor` → null), `apps/api/src/providers/r2.ts` (`r2For` → null), `apps/api/src/estimator/{measure,build,reprice,exact-report,send-proposal,signed-pdf}.ts` (stubs), `apps/api/src/routes/{measurements,tier-templates,estimator-settings,proposals}.ts`, `apps/api/src/public/{proposals,proposal-sign}.ts`, `apps/api/src/jobs/scheduler/{footprints-ensure,exact-report-poll}.ts`, `apps/api/test/estimator-fakes.test.ts`
- Modify: `apps/api/src/{config,deps,app,index}.ts`, `apps/api/src/auth/middleware.ts` (public prefix), `apps/api/src/jobs/{queue,handlers,worker}.ts`, `apps/api/src/tasks/handlers.ts` (register `send_proposal`, `order_exact_report` stubs that throw "not yet"), `apps/api/test/helpers.ts`, `.env.example`, `README.md` env table

**Interfaces:**
```ts
// providers/footprints.ts
export type FootprintFeature = { sourceRef: string; ring: Ring };
export interface FootprintSource { readonly configured: boolean; stateFileUrl(state: string): string; features(state: string): AsyncIterable<FootprintFeature> }
export function createFootprintSource(config: Config): FootprintSource;    // FAKE → FakeFootprintSource (a fixture set around the Omaha showcase); else msFootprintsFor ?? unconfigured
// providers/aerial.ts
export type AerialRoof = { areaSqFt: number; pitchX12: number; structureIndex: number };
export interface AerialMeasure { readonly configured: boolean; start(address: string): Promise<{ requestId: string }>; result(requestId: string): Promise<{ status: 'pending' } | { status: 'complete'; roofs: AerialRoof[] }> }
export class AerialUnavailableError extends Error {}
// providers/exact-reports.ts
export type ExactPrice = { minCents: number; maxCents: number; expiresAt: Date };
export type ExactReport = { surfaceSqFt: number; pitchX12: number; ridgeFt: number; edgeFt: number; valleyFt: number; facets: number | null; reportRef: string };
export interface ExactReports { readonly configured: boolean;
  price(i: { address: { street: string; city: string; state: string; zip: string }; productId: number; referenceId: string }): Promise<ExactPrice>;
  order(i: { address: …; productId: number; referenceId: string }): Promise<{ reportId: string }>;     // may throw ExactOrderUncertainError
  report(reportId: string): Promise<{ status: 'pending' } | { status: 'complete'; report: ExactReport; costCents: number } | { status: 'failed'; reasonKey: string }> }
export class ExactReportsUnavailableError extends Error {} ; export class ExactOrderUncertainError extends Error {}
// providers/object-store.ts
export interface ObjectStore { readonly configured: boolean; put(key: string, bytes: Uint8Array, contentType: string): Promise<void>; get(key: string): Promise<Uint8Array | null> }
export function createObjectStore(config: Config, pools: Pools): ObjectStore;   // R2 when configured; else outside production an in-memory store (tests) — spec's "in-database fake" is simplified to memory for dev/test (Ruling 6)
```
- **Fakes:** `FakeFootprintSource` (rings from `apps/api/test/fixtures/footprints-ne.json` for state `NE`; any other state → empty iterable); `FakeAerialMeasure` (`start` → `req-<n>`; `result` pending once then complete with `{ areaSqFt: 2,480, pitchX12: 7 }`; `/outage/i` address → throws); `FakeExactReports` (price `{4200, 6200}` expiring in 10 min; `order` → `rep-<n>`; `orderUncertainNext()`; `report` pending until `complete(reportId)` is called, with a fixed report `{ surfaceSqFt: 2,612, pitchX12: 7, ridgeFt: 62, edgeFt: 188, valleyFt: 24, facets: 9 }` and cost 4,500); `MemoryObjectStore`. Each records `calls` and has `failNext(n)`.
- **Config:** `EAGLEVIEW_CLIENT_ID`, `EAGLEVIEW_CLIENT_SECRET` (both or neither), `EAGLEVIEW_ENV` (`sandbox|production`, default sandbox), `EAGLEVIEW_PRODUCT_ID` (integer; default the Premium Residential id from the partner onboarding — placeholder `0` until known, meaning "ask before ordering"), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (all or none; **required in production** once any company can sign — a startup warning, not a failure, in E1), `PROPOSAL_LINK_BASE_URL` (http(s) URL, default `APP_ORIGIN`), `FOOTPRINTS_BASE_URL` (default Microsoft's `https://usbuildingdata.blob.core.windows.net/usbuildings-v2/`).
- **`AppDeps` gains** `footprints`, `aerial`, `exactReports`, `objectStore`; `TestApp` gains the four fakes.
- **Jobs:** `JOB_NAMES` gains `'footprints-load'` (data `{ state }`, singletonKey = state; data shape: `JobData` gains `state?: string`, `proposalId?: string`), `'signed-pdf'` (`{ companyId, proposalId }`).
- **Schedules:** `footprints-ensure` `*/15 * * * *` (queues loads for states that companies need), `exact-report-poll` `*/10 * * * *`.
- **Public prefix:** `isPublicRoute` also accepts any path starting with `/public/` (relative to `/api`) for every method; `readOnlyGuard` (F3) exempts `/public/`.
- **Mounts:** `/api/measurements`, `/api/tier-templates`, `/api/estimator/settings`, `/api/proposals`, `/api/public/proposals` (public router: `publicProposalRoutes` + `proposalSignRoutes`), with an IP rate limiter `publicRateLimit()` (60/min/IP) on `/api/public`.
- [ ] **Tests:** config pairs; fakes' documented behaviour; `/api/public/proposals/x` reachable without a session (404 from the stub, not 401); `SCHEDULES` gains the two names; `JOB_NAMES` gains the two; read-only mode doesn't block `/api/public/…` POSTs.
- [ ] **Commit:** `feat(api): E1 skeleton — measurement, aerial, exact-report and storage seams with fakes; public proposal routes`

---

### Task 6: Footprints: loader job and lookup

**Split:** Builder 1 `providers/ms-footprints.ts` (download + streaming parse); Builder 2 `system/footprints.ts` (batch insert, state status, `footprintsNear`) and the two job/schedule handlers; Builder 3 fixtures and tests.

**Files:** Modify `apps/api/src/providers/ms-footprints.ts`, `packages/db/src/system/footprints.ts`, `apps/api/src/jobs/scheduler/footprints-ensure.ts`, `apps/api/src/jobs/handlers.ts` (`footprints-load` → `loadFootprintState`), create `apps/api/src/estimator/footprints-load.ts`; Test `apps/api/test/footprints.test.ts`, fixtures `apps/api/test/fixtures/footprints/NE.geojson.zip` (≤ 200 buildings, made by a script in the test folder from the Omaha showcase area).

**Interfaces:**
```ts
// providers/ms-footprints.ts
export class MicrosoftFootprints implements FootprintSource { constructor(o: { baseUrl: string; fetch?: typeof fetch }) }
// stateFileUrl('NE') → `${baseUrl}Nebraska.geojson.zip` (full state names map; DC → 'DistrictofColumbia'); features() streams: fetch → yauzl (from a temp file under os.tmpdir, deleted after) → stream-json pick 'features' → each Polygon's outer ring
// system/footprints.ts
export async function footprintStateStatus(system: Db, state: string): Promise<FootprintStateStatus | null>;
export async function claimFootprintState(system: Db, state: string, sourceUrl: string, now: Date): Promise<boolean>;   // insert or move failed→loading; false when loading/ready
export async function insertFootprints(system: Db, state: string, batch: readonly FootprintFeature[]): Promise<number>;   // multi-row insert, ST_MakeValid, area in sq ft via geography
export async function finishFootprintState(system: Db, state: string, buildings: number, now: Date): Promise<void>;
export async function failFootprintState(system: Db, state: string, errorPlain: string, now: Date): Promise<void>;   // deletes the partial rows for the state
export async function statesNeedingFootprints(system: Db): Promise<string[]>;   // distinct companies.address_state and properties' states (via app_system grants on companies) not ready/loading
// repos (tenant read) — in repos/measurements.ts (Task 7 owns the file; this task exports from system only)
// estimator/footprints-load.ts
export async function loadFootprintState(deps: AppDeps, state: string, meta: JobMeta): Promise<void>;   // claim → stream → insert batches of 2,000 → finish; throw → fail on lastAttempt
```
- **Decision note:** properties' states are tenant data; `statesNeedingFootprints` reads `companies.address_state` only (global table) plus a per-company "measured state" queue: Task 7 enqueues `footprints-load` directly when a measurement finds its state not ready (Ruling 3).
- [ ] **Tests:** the fixture zip loads (count, areas positive, state ready); a second claim while loading is refused; a failing stream marks failed and leaves no rows; `statesNeedingFootprints` after a company in NE signs up; the schedule queues one job per state (singleton).
- [ ] **Commit:** `feat(estimator): load building footprints by state from Microsoft's open data`

---

### Task 7: Measurements API

**Split:** Builder 1 `repos/measurements.ts` (create, get, update, `footprintsNear` tenant read, lock rule); Builder 2 `estimator/measure.ts` (geocode → footprints → estimate; draw mode; footprint queueing) and `routes/measurements.ts`; Builder 3 tests.

**Files:** Modify `packages/db/src/repos/measurements.ts`, `apps/api/src/estimator/measure.ts`, `apps/api/src/routes/measurements.ts`; Test `apps/api/test/measurements.test.ts`.

**Interfaces:**
```ts
// repos/measurements.ts
export async function footprintsNear(tx: Tx, point: LngLat, radiusM: number): Promise<{ id: string; ring: Ring; areaSqFt: number; contains: boolean; distanceM: number }[]>;
export async function createMeasurement(tx: Tx, ctx: TenantContext, m: NewMeasurement, now: Date): Promise<MeasurementView>;
export async function getMeasurement(tx: Tx, ctx: TenantContext, id: string): Promise<MeasurementView | null>;
export async function updateMeasurement(tx: Tx, ctx: TenantContext, id: string, p: MeasurementPatch, now: Date): Promise<MeasurementView | 'locked' | null>;
export async function setPropertyFootprint(tx: Tx, ctx: TenantContext, propertyId: string, footprintId: string): Promise<void>;
// estimator/measure.ts
export async function measureProperty(deps: AppDeps, ctx: TenantContext, i: { propertyId?: string; address?: string; jobId?: string | null }): Promise<MeasurementView>;
```
- **`measureProperty`:** resolve or create the home (address → C1's server geocoding path); state not `ready` → queue `footprints-load` (singleton) and return a draw-mode measurement (`outline: null`, `drawMode: true`, estimate zeros); else `footprintsNear(point, 40)`: the containing one (or nearest ≤ 30 m) is the main structure (included), others listed excluded; compute `instantEstimate` with the company's `default_pitch_x12` and `overhang_ft`; set the property's `footprint_id` (Decision 9); `method 'outline'`, `kind 'estimate'`.
- **Routes (spec §7):** `POST /api/measurements` (201), `GET /:id`, `PATCH /:id` (outline via `outlineProblem` → 400 field `outline` with "Corners must form a closed shape without crossing lines." / "That outline is too large for a house." / "Add at least three corners."; pitch 0–24; overhang 0–3; valley ≥ 0; included structures by id), lock → 409 per spec. Rep visibility through the property/job scope.
- [ ] **Tests:** a showcase home inside a fixture footprint → estimate equals `instantEstimate` on that ring; nearest within 30 m; none → draw mode; state not loaded → draw mode + one `footprints-load` in `t.jobs.sent`; PATCH outline/pitch recomputes; invalid outlines' messages; locked after a sent proposal (seed status sent) → 409; rep scope; company B 404.
- [ ] **Commit:** `feat(estimator): instant roof measurements from building outlines`

---

### Task 8: Tier templates, estimator settings, proposals API and the proposal PDF

**Split:** Builder 1 `repos/tier-templates.ts`, `routes/tier-templates.ts`, `routes/estimator-settings.ts`, the `prices_and_tiers` setup fact; Builder 2 `repos/proposals.ts`, `estimator/build.ts`, `estimator/reprice.ts`, `routes/proposals.ts`; Builder 3 `proposals/pdf.ts` and tests.

**Files:** Modify `packages/db/src/repos/{tier-templates,proposals}.ts`, `apps/api/src/estimator/{build,reprice}.ts`, `apps/api/src/routes/{tier-templates,estimator-settings,proposals}.ts`, `packages/shared/src/setup.ts` + `packages/db/src/repos/setup.ts` (`prices_and_tiers` done when a pricebook row and three tier rows exist; `SetupFacts` gains `pricesAndTiersSaved: boolean`; `comingWith` null); Create `apps/api/src/proposals/pdf.ts`; Test `apps/api/test/{tier-templates,proposals,proposal-pdf}.test.ts`, `packages/shared/test/setup.test.ts` (extend).

**Interfaces:**
```ts
export async function getTierTemplates(tx: Tx, ctx: TenantContext): Promise<{ templates: TierTemplate[]; isDefault: boolean }>;
export async function saveTierTemplates(tx: Tx, ctx: TenantContext, t: readonly TierTemplate[], now: Date): Promise<TierTemplate[]>;   // exactly three, one per tier
export async function nextProposalNumber(tx: Tx, ctx: TenantContext): Promise<string>;   // 'P-0001'
export async function createProposal(tx: Tx, ctx: TenantContext, p: NewProposal, now: Date): Promise<ProposalView>;
export async function getProposal(tx: Tx, ctx: TenantContext, id: string): Promise<ProposalView | null>;
export async function listProposals(tx: Tx, ctx: TenantContext, q: { status?: ProposalStatus; q?: string; offset?: number }): Promise<{ proposals: ProposalView[]; total: number }>;
export async function updateDraftProposal(tx: Tx, ctx: TenantContext, id: string, p: ProposalPatch, now: Date): Promise<ProposalView | 'not_draft' | null>;
// estimator/build.ts
export async function buildProposal(deps: AppDeps, ctx: TenantContext, i: { measurementId: string; jobId?: string; customer?: { name: string; phone: string; email?: string; askedByText: boolean } }): Promise<ProposalView>;
// estimator/reprice.ts
export async function repriceFromMeasurement(deps: AppDeps, ctx: TenantContext, proposalId: string, measurementId: string): Promise<{ proposal: ProposalView; revised: boolean }>;   // draft → in place; sent/viewed → a new draft (replaced_by on send)
// proposals/pdf.ts
export function renderProposalPdf(i: ProposalPdfInput, o?: { compress?: boolean }): PDFKit.PDFDocument;   // three options summary + per-option inclusions; signature page when given a SignatureRecord + image
```
- **Build:** job (given, or the home's open job, or a new Lead job for the customer — new customer created with `express` consent when `askedByText`), templates (saved or defaults), the C1 pricebook, base scope from the measurement (`areaSqFt = surfaceSqFt`, `areaType 'surface'`, `pitch`, ridge/edge/valley ft, stories 1, layers 1, markup and tax from pricebook defaults), `priceTier` per enabled template, monthly estimate when APR and term are set, `valid_until`, `message_body` = the template text (Task 11's constant), status `draft`, `basis` = the measurement's kind. Activity on the job "Proposal P-0001 drafted".
- **Routes:** spec §7 (create, list, get, patch while draft → 409 "This proposal was sent. Make a revised proposal to change it.", revise, pdf, link (Task 11 fills), send (Task 11 fills)); `GET/PUT /api/tier-templates` (owner edits; office reads; reps 403); `GET/PUT /api/estimator/settings` (owner).
- **PDF:** reuse C1's `PDF_COLORS` and table helpers by import; "Estimate" on every total when `basis = estimate`; no unit prices in the homeowner-facing variant (`audience: 'homeowner'`), unit prices in the internal variant.
- [ ] **Tests:** default templates until saved; save validation; office read-only; build → three options equal to `priceTier`; a disabled option omitted from totals; patch re-prices; financing line only with APR/term; numbering per company; repricing a draft vs a sent proposal; PDF contains `P-0001` and "Estimate"; `prices_and_tiers` done after saves; rep and company B scope.
- [ ] **Commit:** `feat(estimator): tier templates and Good/Better/Best proposals with a PDF`

---

### Task 9: EagleView adapters (orders, reports, Property Data)

**Split:** Builder 1 `eagleview/http.ts` (OAuth client credentials token cache, request, errors) and `eagleview/property-data.ts` (ported from `v1/server/eagleview-sandbox.ts`); Builder 2 `eagleview/orders.ts` and `eagleview/normalize.ts` (ported `normalizeEagleView`, `evNumber`); Builder 3 recorded fixtures and tests.

**Files:** Modify/Create `apps/api/src/providers/eagleview/{http,orders,property-data,normalize}.ts`; fixtures `apps/api/test/fixtures/eagleview/{token,price-order,place-order,get-report-pending,get-report-complete,get-report-failed,pd-request,pd-result-pending,pd-result-complete}.json`; Test `apps/api/test/eagleview.test.ts`.

**Interfaces:**
```ts
export class EagleViewHttp { constructor(o: { clientId: string; clientSecret: string; env: 'sandbox' | 'production'; fetch?: typeof fetch; now?: () => number }) }   // token from https://apicenter.eagleview.com/oauth2/v1/token (client_credentials), cached until expiry − 60 s, one in flight; 401 → refresh once
export class EagleViewOrders implements ExactReports { constructor(o: { http: EagleViewHttp; productId: number; deliveryId: number }) }
export class EagleViewPropertyData implements AerialMeasure { constructor(o: { http: EagleViewHttp }) }
export function eagleViewOrdersFor(config: Config): ExactReports | null;           // client id/secret set and EAGLEVIEW_PRODUCT_ID > 0
export function eagleViewPropertyDataFor(config: Config): AerialMeasure | null;     // client id/secret set
export function normalizeEagleView(raw: unknown): ExactReport;                      // ported; unit parsing via evNumber; ReportId → reportRef
```
- **Hosts:** orders and reports on `webservices-integrations.eagleview.com` (sandbox) / `webservices.eagleview.com` (production): `POST /v2/Order/PriceOrder`, `POST /v2/Order/PlaceOrder`, `GET /v3/Report/GetReport?reportId=`; Property Data on `sandbox.apis.eagleview.com` / `apis.eagleview.com`: `POST /property/v2/request`, `GET /property/v2/result/:id` (202 pending). **Confirm the production auth flavor for Measurement Orders during the partner onboarding** (v1 used a bearer token from the account integration); the adapter keeps auth in `EagleViewHttp` so only that class changes (Ruling 5).
- **Order payload** (v1's): `OrderReports[0]` with the address, `PrimaryProductId`, `DeliveryProductId`, `MeasurementInstructionType: 1` (include garage), `ChangesInLast4Years: false`, `ReferenceId`, `Comments: 'Roofline: US imperial roof measurements requested.'`.
- **Errors:** network/timeout/5xx/429 → `…UnavailableError` (no provider text); PlaceOrder without a confirmed `ReportIds[0]` → `ExactOrderUncertainError`; `GetReport` not complete → pending; status failed → `{ status: 'failed', reasonKey: 'provider_failed' }`; `normalizeEagleView` errors → failed with `reasonKey 'unsupported_units'`.
- [ ] **Tests:** token caching (one token for three calls; refresh on 401); price mapping to cents and expiry 10 minutes; place-order success and an ambiguous response → uncertain; get-report pending/complete/failed; normalization of the fixture (area, pitch, ridge = ridge + hip, edge = eave + rake, valley, facets); Property Data pending/complete with the first structure; no secret or address in any error message.
- [ ] **Commit:** `feat(estimator): EagleView measurement orders and Property Data adapters`

---

### Task 10: Exact report flow and aerial measure

**Split:** Builder 1 `repos/exact-reports.ts` and `estimator/exact-report.ts` (price → draft task; the step handler); Builder 2 `jobs/scheduler/exact-report-poll.ts` + `system/exact-report-fanout.ts` (poll, complete → exact measurement → reprice → usage); Builder 3 aerial measure (`POST /api/measurements/:id/aerial`) and tests.

**Files:** Modify `packages/db/src/repos/exact-reports.ts`, `packages/db/src/system/exact-report-fanout.ts`, `apps/api/src/estimator/exact-report.ts`, `apps/api/src/jobs/scheduler/exact-report-poll.ts`, `apps/api/src/tasks/handlers.ts` (`order_exact_report` → `orderExactReport`), `apps/api/src/routes/measurements.ts` (append the two POST routes — coordinate: Task 7 is merged first); Test `apps/api/test/{exact-report,aerial}.test.ts`.

**Interfaces:**
```ts
export async function requestExactReport(deps: AppDeps, ctx: TenantContext, measurementId: string): Promise<{ taskId: string; orderId: string }>;   // price → order row 'priced' → agent task (estimator, kind 'exact_report') with one order_exact_report step; maxSpendCents = invoiceAmountCents('exact_report', 1, price.maxCents, billingConfig)
export const orderExactReport: StepHandler;   // claim priced→ordering (expired price → re-price; if the new max exceeds the approved max → needs attention "The report price went up. Ask again."); order; waiting; ExactOrderUncertainError → order 'attention' + step needs_attention with the plain v1 message; never retried
export async function pollExactReports(deps: AppDeps, now: Date): Promise<void>;   // fan-out waiting orders (last_polled_at ≤ now − 10 min), per company withTenant
export async function completeExactReport(deps: AppDeps, ctx: TenantContext, orderId: string, r: ExactReport, costCents: number, now: Date): Promise<void>;   // exact measurement (method eagleview, kind exact, outline copied), usage event once (ref ('exact_report', reportId), description 'Exact roof report — <address>'), reprice open proposals (Task 8), activity, order complete
export async function aerialMeasure(deps: AppDeps, ctx: TenantContext, measurementId: string): Promise<MeasurementView>;   // when settings.aerial_measure && deps.aerial.configured: start, poll inline every 3 s for up to 60 s, else 503 "Aerial measure is taking longer than usual. Try again in a minute."; on complete a new measurement (method 'aerial') with the main structure's area and pitch
```
- **Routes:** `POST /api/measurements/:id/exact-report` (owner or office may request; the spend approval decides) → 201 `{ taskId }`; 503 when not configured "Exact reports aren't set up yet."; `POST /api/measurements/:id/aerial` → 201 `MeasurementView` (403 when the company setting is off).
- [ ] **Tests:** request → task with the max spend preview; office approval leaves the step `awaiting_owner`; owner approval orders once; drain twice → one order call; uncertain → attention, no second call; expired price within max → re-price then order; poll pending then complete (fake `complete`) → exact measurement, one usage row (4,500 cost), a draft proposal re-priced, a sent proposal revised; aerial on/off, fake pending then complete, outage → fallback message.
- [ ] **Commit:** `feat(estimator): owner-approved exact reports, re-billing and re-pricing; aerial measure`

---

### Task 11: Sending — the Estimator agent's step and the link

**Split:** Builder 1 `estimator/send-proposal.ts` (task creation, link token mint, body render) and the `send_proposal` handler; Builder 2 `messaging/send-batch.ts` export `sendOneText` (one recipient, purpose given) and the job stage move; Builder 3 `routes/proposals.ts` (`/send`, `/link`) additions and tests.

**Files:** Modify `apps/api/src/estimator/send-proposal.ts`, `apps/api/src/messaging/send-batch.ts` (export only; the lease line stays first in the loop), `apps/api/src/tasks/handlers.ts` (`send_proposal` → `sendProposalStep`), `apps/api/src/routes/proposals.ts`; Test `apps/api/test/proposal-send.test.ts`.

**Interfaces:**
```ts
export const PROPOSAL_TEXT_TEMPLATE = "Hi {first_name}, it's {company}. Here's your roof proposal for {address}: {link} Reply STOP to opt out.";
export async function draftProposalSend(deps: AppDeps, ctx: TenantContext, proposalId: string): Promise<{ taskId: string }>;   // proposal → 'ready'; one send_proposal step; idempotent per proposal (an open draft task is returned)
export const sendProposalStep: StepHandler;   // mint link once (32 bytes, hash + encrypted), render {link} → `${PROPOSAL_LINK_BASE_URL}/p/<token>`, sendOneText(purpose 'informational', dedupeKey 'proposal:<id>'); sent → proposal 'sent', sent_at, job → proposal (C1 rules: only from lead/inspection), activity, event 'sent'; blocked → step result blocked with the gate's reason, proposal back to 'draft'
export async function sendOneText(deps: AppDeps, ctx: TenantContext, step: StepRow, i: { customerId: string; purpose: MessagePurpose; body: string; dedupeKey: string; bodyRendered: true }): Promise<'sent' | 'scheduled' | 'blocked' | 'failed' | 'refused'>;
export function linkFor(config: Config, token: string): string;
```
- **Routes:** `POST /api/proposals/:id/send` → `{ taskId }` (owner, office, or the rep who owns the job — reps can't approve, the draft waits for owner/office); `GET /api/proposals/:id/link` (owner/office) → `{ url }`, event `link_copied`; a signed proposal's link never changes.
- [ ] **Tests:** send → task with the step preview (three totals, "Estimate"); approve → one text with the link, proposal sent, job Proposal, event; no consent → blocked with the gate reason and proposal back to draft; quiet hours → scheduled, proposal sent when the dispatcher sends (status follows); idempotent send task; the token's hash resolves (Task 12 helper stub) and the plain token is never in logs; `{link}` removed in an edit → refused.
- [ ] **Commit:** `feat(estimator): the Estimator agent drafts the proposal text; one approval sends it`

---

### Task 12: Public homeowner API and e-sign

**Split:** Builder 1 `system/proposal-links.ts` (token hash → company/proposal) and `repos/proposal-public.ts`; Builder 2 `public/proposals.ts` (view, events, decline, signed.pdf); Builder 3 `public/proposal-sign.ts` (sign) and tests.

**Files:** Modify `packages/db/src/system/proposal-links.ts`, `packages/db/src/repos/proposal-public.ts`, `apps/api/src/public/{proposals,proposal-sign}.ts`; Test `apps/api/test/{proposal-public,proposal-sign}.test.ts`.

**Interfaces:**
```ts
export async function resolveProposalToken(system: Db, tokenHash: Buffer): Promise<{ companyId: string; proposalId: string; status: ProposalStatus; validUntil: string } | null>;
export async function publicProposalView(tx: Tx, ctx: TenantContext, proposalId: string, now: Date): Promise<PublicProposalView>;
export async function recordProposalEvent(tx: Tx, ctx: TenantContext, proposalId: string, e: { kind: ProposalEventKind; data?: Record<string, unknown>; ipHash: string; userAgent: string }, now: Date): Promise<void>;
export async function signProposal(tx: Tx, ctx: TenantContext, proposalId: string, s: Omit<SignatureRecord, 'documentSha256'> & { documentSha256: string }, now: Date): Promise<'signed' | 'already_signed' | 'closed'>;   // row lock; options frozen; job → won with value; other proposals of the job → replaced; activities; queue 'signed-pdf'
export async function declineProposal(tx: Tx, ctx: TenantContext, proposalId: string, reason: string | null, now: Date): Promise<'declined' | 'closed'>;
```
- **Routes (public):** `GET /api/public/proposals/:token` → `PublicProposalView` (unknown → 404 `{ error: "This proposal link doesn't work." }`; expired for signing → `status 'expired'` and still readable until valid_until + 30 days, then 410 `{ error, companyPhone }`); `POST …/view { optionId? }` → 204 (first view → `first_viewed_at`, job activity "Maria opened the proposal"); `POST …/sign { optionId, consent: true, signerName, typedSignature, drawnSignature?: base64 PNG ≤ 200 KB }` → 200 `{ signed: true }` (validation messages: "Check the box to agree to sign electronically.", "Type your full name.", "Pick an option."); `POST …/decline { reason? ≤ 500 }` → 204; `GET …/signed.pdf` → the stored PDF (404 until ready).
- **Hashes:** `document_sha256 = sha256(canonicalJson(signedDocument(view, optionId, clause)))`; `ip_hash = sha256(ip + company id)` in events; the signature row keeps the raw IP (legal record).
- **Rate limits:** 60/min/IP (Task 5) and 10 sign attempts per token per hour.
- [ ] **Tests:** another company's token never resolves; view counts and the first-view activity; sign → signature row with the expected hash, job Won with the chosen total, other proposals replaced, `signed-pdf` queued; second sign → 409 "This proposal is already signed."; sign after valid_until → 409 "This proposal has expired."; decline; expired 410 page data; drawn signature too large → 400; no session needed; a read-only company's homeowner can still view and sign (Ruling 7).
- [ ] **Commit:** `feat(estimator): the homeowner's proposal link — view, sign electronically, decline`

---

### Task 13: Signed PDF and object storage (R2)

**Split:** Builder 1 `providers/r2.ts` (`aws4fetch` PUT/GET, private bucket); Builder 2 `estimator/signed-pdf.ts` (render with the signature page, hash, store, `stored_files`, email copy) and the `signed-pdf` job handler; Builder 3 `repos/stored-files.ts` and tests.

**Files:** Modify `apps/api/src/providers/r2.ts`, `apps/api/src/estimator/signed-pdf.ts`, `apps/api/src/jobs/handlers.ts` (`signed-pdf`), `packages/db/src/repos/stored-files.ts`; Test `apps/api/test/{r2,signed-pdf}.test.ts`, fixtures `apps/api/test/fixtures/r2/*.txt` (recorded request shapes).

**Interfaces:**
```ts
export class R2ObjectStore implements ObjectStore { constructor(o: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; fetch?: typeof fetch }) }   // https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
export function r2For(config: Config): ObjectStore | null;
export async function makeSignedPdf(deps: AppDeps, companyId: string, proposalId: string, meta: JobMeta): Promise<void>;   // render (homeowner audience + signature page + audit page), sha256, put `companies/<c>/proposals/<p>/signed-<sha>.pdf`, stored_files row, signature.pdf_file_id/pdf_sha256, email copy when the customer has an email (Postmark via deps.mailer; subject "Your signed roof agreement with <company>")
export async function storeFile(tx: Tx, ctx: TenantContext, f: { kind: StoredFileKind; objectKey: string; sha256: string; bytes: number; contentType: string }, now: Date): Promise<string>;
export async function readStoredFile(deps: AppDeps, ctx: TenantContext, fileId: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
```
- [ ] **Tests:** R2 SigV4 request shape against a recorded fixture (host, path, `x-amz-content-sha256`, Authorization prefix); signed PDF contains the signer name, the consent text, the document hash and "Estimate" clause when on; the stored hash equals the bytes' SHA-256; idempotent job (second run doesn't duplicate); `GET …/signed.pdf` streams it; email sent once when an email exists; store failure → retried, signature row untouched.
- [ ] **Commit:** `feat(estimator): tamper-evident signed PDF stored privately, with an email copy`

---

### Task 14: Web skeleton

**Split:** Builder 1 routes (`/estimator`, `/estimator/measure/:measurementId`, `/estimator/proposals/:proposalId`, public `/p/:token` outside `RequireSession` and the shell), dock flag (`estimator` shipped); Builder 2 placeholders and empty `api.ts` per feature, Settings → Prices sections slots (`TiersSection`, `FinancingSection`, `EstimateSection` placeholders under C1's `PricesTab`); Builder 3 copy files (`estimator`, `measure`, `proposals`, `homeowner`, `tiers`) and `test/e1-routes.test.tsx`.

**Files:** Create `apps/web/src/features/{estimator,measure,proposals,homeowner}/{…Window|Page,api}.tsx|ts`, `apps/web/src/features/settings/{TiersSection,FinancingSection,EstimateSection}.tsx`, copy files, test; Modify `apps/web/src/app/router.tsx`, `apps/web/src/shell/apps.ts`, `apps/web/src/features/settings/PricesTab.tsx` (slots only), `apps/web/src/copy/legal.ts` (`footprintAttribution: 'Building outlines © Microsoft, ODbL'` — vendor names are allowed in `legal.ts`).
- [ ] **Tests:** each route renders its placeholder; `/p/abc` renders without a session and without the shell (no dock, no map); the dock's Estimator has no "Coming soon".
- [ ] **Commit:** `feat(web): routes and slots for the Estimator, measuring, proposals and the homeowner page`

---

### Task 15: Web: Estimator window and the address flow

**Split:** Builder 1 `EstimatorWindow.tsx` (address box with typeahead over customers' homes and a geocode-on-submit path; grouped lists); Builder 2 `MakeProposal.tsx` (the one-click "Make proposal": measure → build → send draft → open the R2 review; a new-customer mini form with name, phone, "They asked for this proposal by text"); Builder 3 `features/estimator/api.ts`, `copy/estimator.ts`, tests.
- **Hooks:** `useProposals(filter)`, `useMeasure()` (POST measurements), `useBuildProposal()`, `useSendProposal()` → navigate to `/approvals/<taskId>` (F2 review) .
- **Click budget:** type the address → "Make proposal" (1) → review → Approve (2); when the outline isn't found, "Make proposal" opens the measure view in draw mode instead (the spec's ≤ 3 still holds: draw → "Make proposal" → Approve).
- [ ] **Tests:** the grouped lists from stubbed data; "Make proposal" posts measure, build, send in order and navigates to the review; draw-mode branch; new customer path sends `askedByText`.
- [ ] **Commit:** `feat(web): Estimator window — type an address, make a proposal`

---

### Task 16: Web: measure view with the outline editor

**Split:** Builder 1 `OutlineEditor.ts` (MapLibre layers and pointer handlers: drag a corner, add on an edge midpoint, delete with Delete/long-press, draw mode with clicks and double-click/Enter to finish; keyboard: Tab through corners, arrow keys nudge 0.5 m); Builder 2 `MeasureWindow.tsx` (satellite style from F2's `mapStyle(env, 'satellite')`, structure toggles, pitch picker with diagrams, overhang, the numbers, "Get exact report", "Make proposal"); Builder 3 `copy/measure.ts`, `features/measure/api.ts`, tests (MapLibre mocked as in F2).
- **Geometry in the browser** comes from `@roofline/shared` `roof.ts` (live numbers while dragging); saving PATCHes the outline (debounced 500 ms).
- [ ] **Tests:** editor reducers (pure: `moveCorner`, `insertCorner`, `deleteCorner`, `closeDrawing`) with `outlineProblem` messages; numbers update; pitch change PATCH; exact report button posts and shows "Waiting for your OK"; "Estimate" label present; attribution line.
- [ ] **Commit:** `feat(web): measure on satellite with an editable roof outline`

---

### Task 17: Web: proposal view and editing

**Split:** Builder 1 `OptionCard.tsx` (editable while draft: on/off, name, material, waste, markup, add-ons list editor; live price via `priceTier`); Builder 2 `ProposalWindow.tsx` (status, events, message preview, Send, Copy link, Download PDF, Make revised); Builder 3 `copy/proposals.ts`, `features/proposals/api.ts`, tests.
- [ ] **Tests:** live totals equal `priceTier`; editing PATCHes; a sent proposal is read-only with "Make a revised proposal"; events line "Opened 3 times · last today 7:12 PM"; copy link writes the clipboard (mocked) and toasts.
- [ ] **Commit:** `feat(web): proposal view with three editable options`

---

### Task 18: Web: Settings — templates, financing, estimates

**Split:** Builder 1 `TiersSection.tsx` (three template editors: name, material, waste, markup, add-ons, highlights, enabled); Builder 2 `FinancingSection.tsx` (APR, term) and `EstimateSection.tsx` (default pitch, overhang, proposal valid days, estimate clause toggle, aerial switch when configured); Builder 3 `copy/tiers.ts`, hooks in `features/settings/estimator-api.ts`, the `prices_and_tiers` setup row action (→ `/settings/prices`) in C1/F3's `SetupRow.tsx`, tests.
- [ ] **Tests:** saves send the shared schemas' shapes; validation errors by field path; office read-only; aerial switch hidden when not configured; the setup row link.
- [ ] **Commit:** `feat(web): Good/Better/Best templates, financing and estimate settings`

---

### Task 19: Web: homeowner page and e-sign

**Split:** Builder 1 `HomeownerPage.tsx` (layout, option cards, inclusions, financing line, "Most popular", contact links, expired/declined/signed states); Builder 2 `SignFlow.tsx` (consent checkbox, typed name, optional `SignaturePad.tsx` canvas with pointer and touch, clear, "Sign and accept $14,250", keyboard-only path) and `DeclineSheet.tsx`; Builder 3 `copy/homeowner.ts` (with `CONSENT_TEXT_V1`/`ESTIMATE_CLAUSE_V1` equality test), `features/homeowner/api.ts` (fetch without credentials to `/api/public/proposals/:token`), tests.
- **Rules:** phone-first (375×812 first), 16px inputs to avoid iOS zoom, no third-party scripts, `<meta name="robots" content="noindex">` set via the route, the page never shows unit prices.
- [ ] **Tests:** renders the three options; financing line; sign with keyboard only posts the exact body; the drawn signature path posts a PNG; already-signed and expired states; decline with reason; view event posted once per load.
- [ ] **Commit:** `feat(web): the homeowner's proposal page with electronic signing`

---

### Task 20: Web: job window proposals, R2 previews, Today and Estimator badges

**Split:** Builder 1 the job window's Proposals section (C1 `JobSections.tsx`: status chips, "New proposal" → measure for the job's home); Builder 2 R2 review rendering for the two new step types (previews already flow from the shared `preview()`; add any copy keys and the "Estimate"/"Exact measurements" line); Builder 3 Today ("Signed today" list) and tests.
- [ ] **Tests:** proposals listed in the job window; review shows "Text the proposal to Maria" with the totals and max spend for the exact report; Today lists signed proposals.
- [ ] **Commit:** `feat(web): proposals on the job, review previews, and signed proposals on Today`

---

### Task 21: End-to-end tests, acceptance map, docs

**Files:** Create `apps/web/e2e/{estimator,homeowner}.spec.ts`, `docs/superpowers/e1-acceptance.md`; Modify `apps/web/e2e/{phone,a11y}.spec.ts`, `apps/web/e2e/stack.ts` only if a new env is needed (`FAKE_PROVIDERS` already on), `README.md` (EagleView, R2, link base env; footprints loader note).
- **Fixtures:** the e2e reset seeds `building_footprint_states` NE `ready` and the fixture footprints (through a new `seedFootprintFixture(pools)` exported from `apps/api/src/index.ts` — add the export in this task).
- **Tests:** `test('typed address to sent in 3 clicks')` (owner; an Omaha showcase address; `clicks.count <= 3`; the review shows three totals; after Approve the step shows Done and the fake SMS adapter got a text containing `/p/` — check through the proposal view's status "Sent"); `test('exact report: owner approves the spend')` (the order reaches "Waiting for the report"; completion and re-pricing are Task 10's integration tests, Ruling 8); `homeowner.spec.ts` (phone project): open the link from the proposal view's Copy link, view, choose Better, sign with the keyboard only, see "Signed" and the download link, then the owner's job shows Won with the value; a11y on `/estimator`, the measure view, the proposal view and `/p/<token>`; phone no-scroll on the homeowner page and the proposal view.
- **`e1-acceptance.md`:** every spec §11 bullet → its tests.
- [ ] **Verify:** typecheck, lint, `npx playwright test --list`; CI E2E via `ci-check`.
- [ ] **Commit:** `test(e2e): address to sent in 3 clicks; the homeowner signs on a phone; E1 acceptance map`

---

### Task 22: Manual smoke: EagleView sandbox, R2, a real text

**Files:** Create `apps/api/src/scripts/smoke/estimator.ts`, `docs/superpowers/e1-manual-smoke.md`, `apps/api/test/smoke-estimator-guards.test.ts`; Modify `apps/api/package.json` (`smoke:estimator`).
- `smoke:estimator --confirm-real-providers [--eagleview-sandbox] [--r2] [--sms <E.164>]`: EagleView sandbox token, Property Data on a documented Omaha address, PriceOrder (sandbox) — never PlaceOrder unless `--place-order` (costs money in production; refused unless `EAGLEVIEW_ENV=sandbox`); R2 put/get/delete of a test object; one real proposal text to the given test phone through the real send path on staging. Prints no secrets.
- **Runbook:** each check, its command and expected result; footprints for one real state loaded on staging (time and size recorded); a sign-off table.
- [ ] **Commit:** `test(smoke): EagleView sandbox, R2 and a real proposal text, by hand only`

---

## Rulings

1. **All E1 schema is in Task 1's migrations (0014, 0015);** Task 1 is the only lockfile edit (`yauzl`, `stream-json`, `aws4fetch` and their types).
2. **Skeleton tasks own the hotspots:** Task 1 (schema, barrels, lockfile), Task 5 (`app.ts`, `config.ts`, `deps.ts`, `auth/middleware.ts` public prefix, `jobs/*`, `tasks/handlers.ts` registrations, `test/helpers.ts`, env docs), Task 14 (`router.tsx`, `shell/apps.ts`, `PricesTab.tsx` slots, `copy/legal.ts`).
3. **Footprint loads are queued two ways:** the 15-minute schedule for company address states (global data), and directly by `measureProperty` when a measured home's state isn't ready (tenant work never reads other companies' properties).
4. **`shared/setup.ts` and `repos/setup.ts` are edited only by Task 8** in E1 (`prices_and_tiers`).
5. **EagleView auth lives only in `EagleViewHttp`;** if the partner onboarding gives Measurement Orders a different auth (v1 used an account bearer token), only that class changes.
6. **Dev/test object storage is in memory;** production without R2 logs a startup warning and signed PDFs wait (the signature record is saved regardless); the controller turns the warning into a refusal once R2 exists.
7. **Read-only companies (F3 `trial_ended`/`canceled`):** homeowners can still view and sign (the public routes are exempt from `readOnlyGuard`), because the homeowner's acceptance is not the roofer's write; sending new proposals is blocked by read-only mode as usual.
8. **E2E covers the outbound flows and the homeowner signing;** EagleView completion, aerial measure and footprint loading are proven by integration tests with fakes and fixtures, since the e2e API runs in another process.
9. **Proposal texts are informational** (master §9.1: "a proposal the customer asked for") and always go through the send gate; a company switch for zero-click sending is out of E1 (spec Decision 12).

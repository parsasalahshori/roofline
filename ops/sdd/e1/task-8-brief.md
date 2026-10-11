### Task 8: Tier templates, estimator settings, proposals API and the proposal PDF

**Base:** `e1-estimator` after Tasks 3, 4 and 5 are merged. From T3: `priceTier`, `DEFAULT_TIER_TEMPLATES`, `TierTemplateSchema`, `monthlyPaymentCents`. From T4: `ProposalView`, `ProposalOptionView`. **[C1]** From C1 T15: `getPricebook(tx, ctx) → PricebookView` (`repos/pricebook.ts`), `DEFAULT_QUOTE_DEFAULTS`. **[C1]** From C1 T16: `PDF_COLORS` (`apps/api/src/quotes/pdf.ts`) — Ruling EC: import only `PDF_COLORS`; write table helpers in `proposals/pdf.ts`; do not edit C1's file. **[C1]** From C1 T6: `createJob`/`updateJob` with stage rules. **[C1]** From C1 T12: `SetupFacts.calendarsConnected` already added to `shared/setup.ts`/`repos/setup.ts` (F3 T16's `setupFacts`) — add `pricesAndTiersSaved` beside it.

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

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

**Tests:**
- default templates until saved; save validation; office read-only; build → three options equal to `priceTier`; a disabled option omitted from totals; patch re-prices; financing line only with APR/term; numbering per company; repricing a draft vs a sent proposal; PDF contains `P-0001` and "Estimate"; `prices_and_tiers` done after saves; rep and company B scope.

**Carries and rulings:**
- **Ruling EC** (see Base).
- **Ruling ED:** `listProposals` also takes `signedOn?: string` (company-zone date) so T20's Today list needs no change to C1's `TodayView`.
- This task is E1's only editor of `shared/setup.ts` and `repos/setup.ts`.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(estimator): tier templates and Good/Better/Best proposals with a PDF`

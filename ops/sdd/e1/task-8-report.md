# E1 Task 8 report: tier templates, estimator settings, proposals API, proposal PDF

Branch `e1-t8`, base `693e2df` (e1-estimator + C1 T6 + scratch `apps/api/src/quotes/pdf.ts` with only `PDF_COLORS`).
Commits: `fe3e12b` (build), `3523f8b` (CI fix), `1735fd2` (review fixes). Review CI 38216142539 on `1735fd2`: Platform passed, E2E passed.

## What T8 built (from the diff)

- `packages/db/src/repos/tier-templates.ts`: `getTierTemplates` (defaults + `isDefault` until saved), `saveTierTemplates`
  (exactly one per tier, upsert on `(company_id, tier)`), `getEstimatorSettings` / `saveEstimatorSettings` (partial upsert on
  `company_settings`).
- `packages/db/src/repos/proposals.ts`: `nextProposalNumber` (counter row `insert … on conflict do update … returning`, which
  row-locks inside the creating transaction, so concurrent creates serialize; per company, `P-0001`), `createProposal`,
  `getProposal`, `listProposals` (`status`, `q`, `offset`, Ruling ED `signedOn` in the company zone), `updateDraftProposal`
  (re-prices patched options from the stored pricebook/quantities snapshot; `FOR UPDATE` on the draft row; `not_draft` for
  anything sent), `getMeasurementBasics`, `replaceDraftOptions` (reprice in place). Rep scope via `jobScope` on every read
  and write; company via RLS plus an explicit `company_id` filter.
- `apps/api/src/estimator/build.ts`: `buildProposal` (given job, else the home's open job, else a new Lead job, creating the
  customer with `express` consent when `askedByText`), `priceOptions` (all three tiers in TIERS order, disabled ones stored with
  `enabled: false`), financing monthly estimate only with APR and term, `validUntilFor`, activity "Proposal P-0001 drafted".
- `apps/api/src/estimator/reprice.ts`: `repriceFromMeasurement` (draft in place; any other status → a new draft, the old one
  untouched, activity "… (revised from P-000N)").
- Routes: `POST/GET /api/proposals`, `GET/PATCH /api/proposals/:id` (409 "This proposal was sent. Make a revised proposal to
  change it."), `POST /:id/revise`, `GET /:id/pdf` (attachment); `GET/PUT /api/tier-templates` (owner edits, office reads,
  reps 403, audited, field errors `templates.N.key`); `GET/PUT /api/estimator/settings` (audited; APR and term set together).
- `apps/api/src/proposals/pdf.ts`: `renderProposalPdf` (imports only `PDF_COLORS`, Ruling EC; own table helpers): summary of
  enabled options in TIERS order, per-option inclusions, unit-price tables only for `audience: 'internal'`, "Estimate total"
  on every total when `basis = estimate`, financing line, signature page.
- Setup: `SetupFacts.pricesAndTiersSaved` (a pricebook row and three tier rows), `prices_and_tiers` no longer "Coming with";
  `apps/web/e2e/setup.spec.ts` now expects 2 "Coming with" lines.

## Team history

- First CI run 38209155824 failed: replacing draft options used DELETE, and `app_tenant` has no DELETE grant on
  `proposal_options` (migration 0016). `3523f8b` replaced it with a per-tier upsert on `(proposal_id, tier)`.
- CI 38210783532 on `3523f8b`: green (Platform and E2E).

## Review findings and outcomes

| # | Finding | Severity | Outcome |
|---|---|---|---|
| 1 | `buildProposal` accepted a `jobId` at a different home from the measurement, pairing one home's job/customer with another home's roof | Important | Fixed: 400 `field: 'jobId'` when `job.propertyId !== measurement.propertyId`; test in `proposals.test.ts` |
| 2 | `repriceFromMeasurement` accepted a measurement of another home (T10 entry point) | Important | Fixed: 400 `field: 'measurementId'`; test |
| 3 | `updateDraftProposal` silently ignored option ids not on the proposal | Important | Fixed: `UnknownProposalOptionError(index)` (also for an id named twice), thrown before any write; PATCH maps to 400 `options.N.id`; repo and route tests (the old test that sent `NO_UUID` and expected success was corrected) |
| 4 | PDF route piped the stream after headers: a failure mid-stream gave a truncated 200 download | Important | Fixed: `pdfToBuffer(doc)` renders fully, then headers + `res.send`; failure → standard 500 JSON. `Content-Disposition: attachment` kept. Unit tests for `pdfToBuffer` |
| 5 | PATCH body checks without explicit messages | Minor | Functionally already "Please check this field." via `parse()`'s contextual error map (verified); made explicit on every check for consistency; route test asserts the full `{error, field}` body |
| 6 | Open-job lookup took `limit 1` then dropped it if archived, missing an older open job | Minor | Fixed: `archived_at is null` in the WHERE |
| 7 | `GET /api/estimator/settings` was owner-only, but Settings → Prices (visible to office) renders `EstimateSection` / `FinancingSection` read-only for office, so office got a 403 error box | Important (API/web mismatch) | Fixed on the API side: GET needs `view_money_totals` (owner + office), PUT stays `company_admin`; test updated (office GET 200, PUT 403, rep GET 403) |
| 8 | Number allocation concurrency | — | Confirmed safe: upsert on the counter row locks it in the creating transaction; concurrent test present |
| 9 | Sent/viewed/signed never re-priced or edited | — | Confirmed: PATCH and `replaceDraftOptions` lock and refuse non-drafts; reprice of non-draft creates a new draft and leaves the old row unchanged (test compares before/after) |
| 10 | Rep visibility / other company | — | Confirmed: `jobScope` on get/list/draft row; build uses scoped `getJob`/`getProperty` and a scoped open-job lookup; company B ids 404 (tests) |
| 11 | Estimate labelling and homeowner unit prices | — | Confirmed: every total says "Estimate total" when basis is estimate; unit-price tables only in the internal variant; reps get the homeowner variant |

Not changed (noted):
- A rep building at a home where another rep's open job exists cannot see that job, so a second Lead job is created. Same rule
  as C1's scoping; accept or revisit in C1.
- With `customer` given on a home that already belongs to a different customer, the new customer gets the job but the home is
  not relinked. Edge case; left.
- `DEFAULT_PROPOSAL_MESSAGE` doc comment says `{first_name}`/`{company}` are filled when drafted, but `message_body` is stored
  with all placeholders raw. T11 fills them at send (see carries).

## API shapes vs the web

- `features/proposals/api.ts`: PATCH body `{options: [{id, ...}], messageBody}` → ProposalView; revise → ProposalView; PDF URL
  `/api/proposals/:id/pdf` with attachment. Match.
- `features/estimator/api.ts`: `POST /api/proposals {measurementId, customer?}` → ProposalView; `GET /api/proposals?status=&q=`
  → `{proposals, total}`. Match (`q=` empty is accepted).
- `features/settings/estimator-api.ts`: tier templates `{templates}` (API also sends `isDefault`, harmless); estimator settings
  = `EstimatorSettings`. Match after fix 7.
- `send` and `link` are T11 (web already calls them).

## Carries

- **T11 (send_proposal):** `ProposalView.options` is always three options in TIERS order (`position` 0-2), disabled ones
  included with `enabled: false`. The send preview labels totals by position only when there are 3 totals, so a proposal with a
  disabled tier must send `{tier, totalCents}` pairs (recommended) or the preview mislabels. T11 must also: fill
  `{first_name}`, `{company}`, `{address}`, `{link}` at send; overwrite the placeholder `link_token_hash` (random) and empty
  `link_token_encrypted`; set `replaced` / `replaced_by_id` on the old proposal when a revised draft is sent, but **never on a
  signed proposal** (Review Focus 2). Today `revise` creates a new draft from any non-draft status, including
  signed/declined/expired/replaced; the lead should decide whether `revise` on signed answers 409. `ProposalView.taskId` is
  always null until T11.
- **T10 (exact report):** `repriceFromMeasurement` now answers 400 `measurementId` for a measurement of another home; pass a
  measurement of the proposal's property. It creates a revised draft for any non-draft, including signed: T10 should skip
  signed proposals.
- **T12 (signing / signed PDF):** use `renderProposalPdf({..., signature})` plus `pdfToBuffer` to get the bytes for
  `document_sha256` / the PDF hash and R2 storage; homeowner variant has no unit prices; `inclusions` keyed by option id is
  available for homeowner-safe text.
- Merge rule unchanged: `apps/api/src/quotes/pdf.ts` add/add → C1 T16's file.

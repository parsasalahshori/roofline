# E1 whole-branch review B: money and prices

Reviewer B. Worktree /home/user/wt/e1-review at b1a4980, diff `origin/c1-crm..HEAD -- apps packages`. Read-only; no DB tests run.
Rulings EA–EP were taken as given. Line numbers are at b1a4980.

## Critical

None found.

## Important

### B1. A 'ready' proposal keeps its pending send after an exact report revises it (Ruling EO is not met)
- `apps/api/src/estimator/reprice.ts:25-46`, `apps/api/src/estimator/exact-report-complete.ts:26,124-142`, `apps/api/src/estimator/send-proposal.ts:140-141`.
- What goes wrong: for a 'ready' proposal, `repriceFromMeasurement` creates a new revised draft and leaves the old proposal 'ready'. Its `send_proposal` task (still `awaiting_owner`, with the old totals in its preview) stays open. `sendProposalStep` accepts 'ready', so approving it texts the old estimate prices and the link to the old proposal, which is what Ruling EO was meant to prevent. `markReplacedProposal` only replaces 'sent'/'viewed', so the old 'ready' proposal is never closed, even after the revised draft is sent. The `POST /:id/revise` route does the same for a 'ready' proposal.
- Trigger: a rep sends a proposal for approval, the exact report arrives before the owner approves, and the owner then approves the waiting send.
- Fix: in `repriceFromMeasurement`, when `existing.status === 'ready'`, lock the row and move it `ready -> replaced` with `replaced_by_id = draft.id` in the same transaction (for example `setProposalStatus(tx, ctx, id, ['ready'], 'replaced', now)` plus the id). `sendProposalStep` then returns `needs_attention` with CLOSED_MESSAGE (line 141) and nothing old goes out. You can also decline or cancel the open send task (`findOpenSendTask`).

### B2. A retried send step texts a draft whose prices changed after approval
- `apps/api/src/estimator/send-proposal.ts:141,180-183`, together with `retryStep` (`apps/api/src/tasks/service.ts:650`).
- What goes wrong: when a send is blocked or failed, the proposal goes back to 'draft' (`setProposalStatus ready -> draft`). At that point a rep can PATCH the draft's options (markup, material, add-ons, enabled). If the owner or office then presses Retry on the `needs_attention` step, `sendProposalStep` accepts 'draft' (line 141) and sends the edited proposal. The approval preview showed the old `totals`, so the homeowner gets prices nobody approved. `draftProposalSend` can also hand back the same old task through `findOpenSendTask` while the task is still `running`, so its stale preview is reused.
- Trigger: a send is blocked (consent missing), the rep fixes the consent and lowers the markup on the draft, and the office retries the step.
- Fix: send only from 'ready'. A 'draft' should give `needs_attention` with "This proposal changed. Send it again for approval.", which forces a new `draftProposalSend` and a new preview. A belt-and-braces check: compare the enabled options' `totalCents` with `payload.totals` before sending.

### B3. An exact report's billed cost is not capped by the approved maximum, and a cost of 0 is billed as 0
- `apps/api/src/jobs/scheduler/exact-report-poll.ts:217-219`, `apps/api/src/estimator/exact-report-complete.ts:88-97`, `apps/api/src/providers/eagleview/orders.ts:137-139,202-209`.
- What goes wrong (1): usage is recorded at `result.costCents`, the cost on the report, with no bound. The owner approved `maxSpendCents = invoiceAmountCents(priceMaxCents)`. If GetReport's `Cost`/`TotalPrice` is higher than the quoted `priceMaxCents`, the invoice goes over the spend the approval showed. Review Focus 3 says the approved max bounds the order.
- What goes wrong (2): `priceDollars` accepts `0` (`value >= 0`), so a report with `"Cost": 0`, or `"0.00"`, gives `costCents: 0`. That is billed as a free report and goes against the "never bill 0" rule that the null fallback was added for.
- Trigger: EagleView adds a surcharge (a re-measure, a larger structure), or sends `Cost: 0` on an account-billed report.
- Fix: in the poll, `const reported = result.costCents !== null && result.costCents > 0 ? result.costCents : null; const cost = reported === null ? order.priceMaxCents : Math.min(reported, order.priceMaxCents ?? reported);`. Also treat `dollars <= 0` as null in `completeReport`, the same way `price()` already does at line 85.

### B4. Two exact-report requests for one home create two orders that can both be approved and billed
- `apps/api/src/estimator/exact-report.ts:44-95`. `exact_report_orders` has no uniqueness per measurement or property (`packages/db/src/schema/tenant.ts:1160-1161`).
- What goes wrong: every `POST /api/measurements/:id/exact-report` prices again, inserts a new 'priced' order and drafts a new spend task. Nothing checks for an open order ('priced', 'ordering', 'waiting') on the same measurement or home, so two approvals mean two EagleView orders and two `exact_report` usage events.
- Trigger: the owner and the office (or one user after a reload, or on a second device) both click "Get exact report", and the owner approves both tasks in the queue.
- Fix: inside the insert transaction, look for an open order for the same measurement's property. If one exists, return its `{taskId, orderId}`; if it is 'waiting', answer 409 "An exact report is already on its way". Back this with a partial unique index on `(company_id, measurement_id) WHERE status IN ('priced','ordering','waiting')`. That needs a migration, so it goes to the owner or a later milestone. Until then the check-then-insert can run under a `FOR UPDATE` lock on the measurement row.

### B5. Exact and aerial measurements show, and can overwrite, outline-derived numbers
- `packages/db/src/repos/measurements.ts:207-211` (view), `:280-297` (PATCH), and the client at `apps/web/src/features/measure/MeasureWindow.tsx:163-171`.
- What goes wrong: `getMeasurement` always rebuilds `estimate` with `instantEstimate(outline, pitch, overhang)` and ignores the stored `surface_sq_ft`, `edge_ft` and `ridge_ft`. An EagleView (exact) or aerial measurement therefore shows the outline's area and lengths, labelled "Exact", while the proposal is priced from the stored report numbers (`getMeasurementBasics`). Worse, the measurement is not locked until a proposal is sent, so a PATCH, even of pitch alone, writes outline-derived surface, edges and ridge over the report's values. `kind` stays 'exact' and `method` stays 'eagleview', so the next proposal says "Based on an exact roof report" with estimate numbers.
- Trigger: the exact report arrives, the rep opens the measure window, and nudges pitch or overhang.
- Fix: for `kind === 'exact'` or `method === 'aerial'`, the view takes surface, edges, ridge, valley and pitch from the stored columns, with squares = surface/100. `updateMeasurement` refuses edits to an exact measurement (409, "Make a new measurement to change it") or creates a new 'estimate' measurement instead. The web disables the edit controls when `m.kind === 'exact'`.

### B6. Financing terms on the homeowner page and in the PDF are read live, but the monthly amount is frozen
- `packages/db/src/repos/proposal-public.ts:45-46,95,118-119`, `apps/api/src/routes/proposals.ts:169-183`, `apps/api/src/proposals/pdf.ts:79-82`.
- What goes wrong: `monthlyEstimateCents` is frozen on the option when it is priced, but `financingTerms` (APR and months) come from today's `company_settings`. If the owner changes APR or term after a proposal is sent, the page and PDF show something like "About $212/mo · 7.99% for 60 months", where $212 was worked out at the old 9.99%/120. If financing is later turned off, the frozen monthly figure is still shown, and `signedDocument` hashes the mismatched pair. A sent proposal's money statement therefore drifts (Review Focus 4).
- Trigger: the owner edits Settings → Prices → Financing while proposals are out.
- Fix: freeze the terms with the amount. Store `aprBps`/`months` on `proposal_options`, or in the option's `prices` jsonb (`StoredPrices`) where it is written in `optionRow`. `buildPublicView` and the PDF route should read them from there, and a null monthly amount should hide the line.

### B7. The internal PDF lists every add-on line twice
- `apps/api/src/proposals/pdf.ts:131`, together with `packages/shared/src/tiers-price.ts:16-23`.
- What goes wrong: `withAddOns` already returns `calculation.lines = [...calc.lines, ...addOnLines]`. The PDF prints `[...o.calculation.lines, ...o.addOnLines]`, so on Better and Best "Ice & water shield", "Ridge vent" and "Extended workmanship warranty" each appear twice, and the line totals no longer add up to the printed Subtotal.
- Trigger: the owner or office downloads the PDF of any proposal with add-ons (the default Better and Best).
- Fix: `const lines = o.calculation.lines;`.

## Minor

### B8. Instant geometry the pricing engine refuses gives a vague 400 instead of a plain message
- `apps/api/src/estimator/build.ts:88-104` → `calculateQuote`'s `scopeSchema.parse` (`packages/shared/src/pricing.ts:20,25`).
- What goes wrong: `areaSqFt` must be positive and at most 100,000, but the outline check allows up to 200,000 sq ft of footprint (`roof-geometry.ts:7`), and auto-picked footprints are not checked at all. A warehouse footprint, a draw-mode measurement with no outline, all structures unticked, or 3 collinear corners (area 0, which passes `outlineProblem`) all make `POST /api/proposals` fail with the last-stop ZodError mapping: 400 "Please check this field." with `field: 'areaSqFt'`, a field the screen does not have. It is not a 500, but it is not a plain result either.
- Fix: in `priceOptions` or `buildProposal`, check `m.surfaceSqFt > 0`, `<= 100000` and lengths `<= 10000` first, and throw an AppError with our own sentence ("Draw the roof outline first." / "That roof is too large for an instant proposal. Order an exact report."). Set `TOO_LARGE_SQFT` so that an accepted outline at pitch 24/12 plus the maximum overhang stays within the pricing bound, and treat a zero-area ring as 'too_few_corners'.

### B9. A reprice can still revise a proposal signed moments earlier (Ruling EJ race)
- `apps/api/src/routes/proposals.ts:155-158`, `apps/api/src/estimator/exact-report-complete.ts:124-138`, `apps/api/src/estimator/reprice.ts:15-25`.
- What goes wrong: the 'signed' check is made outside the reprice transaction (the route), or at select time (exact report). `repriceFromMeasurement` itself never checks status beyond 'draft' and does not lock the row. If the homeowner signs in between, a revised draft is created from a signed proposal.
- Fix: in `repriceFromMeasurement`, read the proposal `FOR UPDATE` (as `lockProposalForSend` does) and throw 409 SIGNED_PROPOSAL_MESSAGE for 'signed' (and refuse 'replaced'). The exact-report loop already catches the error per proposal.

### B10. Re-pricing a draft in place drops the rep's per-option edits
- `packages/db/src/repos/proposals.ts:372-385` with `priceOptions` (`build.ts:84-121`).
- What goes wrong: when an exact report arrives, the draft's options are rebuilt from the current templates. A markup the rep lowered, a material change, edited add-ons, a rename or a disabled tier are all reset with no notice, and the next send carries template prices. The send preview does show the new totals, so this is Minor.
- Fix: in place, keep each option's `name`, `enabled`, `material`, `wastePercent`, `markupPercent` and `addOns`, and re-run `priceTier` on the new quantities only, as `updateDraftProposal` already does.

## Checked and found correct
- Rounding in `withAddOns` and `priceTier` matches `calculateQuote` (per-line `Math.round(q × unitCents)`, markup on subtotal, tax on `round(taxable × (1+markup))`). Add-on quantities come from the measured quantities, per-square with waste, and lines of quantity 0 are skipped.
- `monthlyPaymentCents`: amortization, 0% → ceil(P/n), and guards on months, APR and principal. Settings bounds (APR 0–5000 bps, term 1–360) keep it from throwing.
- Order claim (`claimExactOrder`, priced → ordering, a single conditional UPDATE in its own transaction) happens before any provider call. An uncertain or refused order goes to 'attention' and is never re-ordered. A failed price refresh gives the claim back. A fresh price above the approved max is refused before ordering.
- Two pollers: `completeExactReport` claims waiting → complete before creating the measurement, and `recordUsage` is idempotent on (company, kind, refType, refId), so one measurement and one usage event per report. The no-cost-and-no-max case is never billed.
- Provider text: EagleView errors map to our own sentences, and `error_plain` holds only module constants.
- Proposal numbers: the counter upsert locks the row, so concurrent creates serialize.
- Sent, viewed and signed proposals are never edited (`draftRow` / `updateDraftProposal` → 'not_draft'). Revise on signed answers 409 (Ruling EJ, apart from the race in B9).
- Homeowner surfaces (public view `inclusions`, homeowner PDF) carry no unit prices. Every total on the PDF and in the step preview carries the Estimate/exact basis.
- Measurement lock: only a sent (or later) proposal locks, the row is locked FOR UPDATE before the check, and the 409 uses the spec's text.

# E1 acceptance checklist (spec section 11)

Status: the API, worker, database and shared-package tests below are database-backed where noted and run in CI (`.github/workflows/ci.yml`, the Platform job). This machine has no Docker, so the Playwright specs added for E1 (`estimator.spec.ts`, `homeowner.spec.ts` and the new cases in `a11y.spec.ts` and `phone.spec.ts`) could only be listed locally with `npx playwright test --list -c apps/web/playwright.config.ts`; they are proven by the CI `E2E (Playwright)` job. Signed PDF storage (T13) merges before this task; the e2e flow does not depend on the PDF being ready after signing (the page may show the signed state with `pdfReady` false), so the stored-and-downloadable clause is proven by T13's API tests and the web unit test, not by e2e.

Ruling 8: EagleView completion, aerial measure and footprint loading are proven by integration tests, not e2e. The EagleView adapters are tested against recorded responses and the fakes; the browser never talks to a live provider.

Paths are under `packages/<name>/test/` (unit), `apps/web/test/` (web components), `apps/api/test/` and `packages/db/test/` (API and integration), `apps/web/e2e/` (Playwright). Note: in `apps/web/playwright.config.ts` the `phone` project matches only `phone.spec`, so `homeowner.spec.ts` and the other specs run in the `desktop` project unless the spec sets a 375x812 viewport itself.

## Measure
- **A seeded home with a fixture footprint gets an outline and an instant estimate whose surface area matches the formula**
  - Unit: `packages/shared/test/roof-geometry.test.ts`: "40 x 30 ft rectangle has area 1200 and perimeter 140 within 0.5%"; "pitch factor is sqrt(1 + (p/12)^2)"; "minimum rotated rectangle of 40 x 30 ft is 40 by 30"; "L-shaped outline area is the rectangle minus the notch".
  - Unit: `packages/shared/test/roof-estimate.test.ts`: "gives footprint, plan, surface, squares, edges and ridge for a 40 x 30 ft rectangle at 6/12 with 1 ft overhang"; "gives plan equal to footprint when overhang is 0"; "rounds areas and lengths to one decimal".
  - Unit: `packages/shared/test/roof.test.ts`: "40 x 30 rectangle instant estimate at 6/12 with 1 ft overhang".
  - API: `apps/api/test/measurements.test.ts`: "a home inside a fixture footprint measures to instantEstimate on that ring"; "uses the nearest footprint within 30 m"; "other nearby buildings are listed excluded".
  - Integration (footprint loading, Ruling 8): `apps/api/test/footprints.test.ts`: "the fixture zip loads"; "the footprints-load job runs through InlineJobs with the default handlers"; `apps/api/test/footprints-provider.test.ts`: "features streams the 6 polygons of the NE fixture, skipping the multipolygon, the point and the unclosed ring".
  - e2e: `apps/web/e2e/estimator.spec.ts`: "typed address to sent in 3 clicks" (the Omaha showcase address lands inside a fixture footprint, so Make proposal measures, builds and sends straight to the approval screen with no measure view; the measure view itself is opened in the "exact report: owner approves the spend" e2e and the "measure view has no serious accessibility violations" a11y test).
- **Adjusting a corner or the pitch updates the numbers**
  - Web: `apps/web/test/measure.test.tsx`: "numbers update when pitch changes and a pitch PATCH is sent"; "dragging a corner updates the numbers live and saves once after 500 ms"; "arrow keys nudge a corner by half a metre"; "Delete removes a corner, and going under three corners warns and saves nothing"; "moveCorner moves exactly one corner and does not touch the input".
  - API: `apps/api/test/measurements.test.ts`: "PATCH outline recomputes the estimate; PATCH pitch recomputes; included structures toggle; GET matches"; "rejects bad outlines with plain messages, and out-of-range numbers name their field".
  - Unit: `packages/shared/test/roof-geometry.test.ts`: "outlineProblem: a bow-tie at house size is self-intersecting"; "outlineProblem: a 600 x 500 ft rectangle is too large".
- **A home with no footprint opens draw mode**
  - API: `apps/api/test/measurements.test.ts`: "no footprint near the point gives draw mode"; "a state that is not loaded gives draw mode and queues one footprints-load"; "a home with no point opens draw mode on the centre of the US".
  - Web: `apps/web/test/measure.test.tsx`: "draw mode: three clicks then Enter saves a three-corner outline"; "draw mode: the Finish outline button saves the drawn corners"; `apps/web/test/estimator.test.tsx`: "opens draw mode when the outline is not found".
- **The property's `footprint_id` is set**
  - API: `apps/api/test/measurements.test.ts`: "a home inside a fixture footprint measures to instantEstimate on that ring" (also asserts the property's `footprintId` is the matched building).

## Exact report
- **Price, then the spend step (owner only), then order**
  - API: `apps/api/test/exact-report-routes.test.ts`: "as owner -> 201 {taskId}"; "as rep -> 403"; "not configured -> 503 \"Exact reports aren't set up yet.\"" (quoted as it appears in the file).
  - API: `apps/api/test/exact-report.test.ts`: "request creates a task whose order step previews the max spend"; "office approval leaves the step awaiting_owner"; "owner approval orders once"; "draining the step twice makes one order call"; "an expired price within the approved max is re-priced then ordered"; "a price above the approved max needs attention and orders nothing".
  - Unit: `packages/shared/test/steps-e1.test.ts`: "is a spend step"; "maxSpendCents must be a whole number of 0 or more"; "preview gives the title, the address as the one line and the ceiling".
  - Web: `apps/web/test/e1-review-previews.test.tsx`: "order_exact_report step shows the address and the max spend"; `apps/web/test/measure.test.tsx`: "Get exact report posts and shows Waiting for your OK".
  - Adapters (recorded responses): `apps/api/test/eagleview.test.ts`: "price maps dollars to cents"; "place-order success returns the report id as a string".
  - e2e: `apps/web/e2e/estimator.spec.ts`: "exact report: owner approves the spend". The brief says the order reaches "Waiting for the report", but no such copy exists. A parked order keeps its step running (apps/api/src/estimator/exact-report.ts), so the test asserts the step reads "Working on it" (apps/web/src/copy/status.ts), waiting up to 20 s past "Starting soon".
- **Poll, then the exact measurement, then the draft is re-priced (a sent proposal gets a revised draft)**
  - Integration (Ruling 8): `apps/api/test/exact-report-poll.test.ts`: "a pending report stays waiting and is stamped polled; not asked again within ten minutes"; "a complete report makes an exact measurement"; "a draft proposal is re-priced in place"; "a sent proposal is untouched and a revised draft is made"; "a ready proposal (its send awaiting approval) gets a revised draft too (Ruling EO)"; "the order is complete and its step done".
  - Adapters: `apps/api/test/eagleview.test.ts`: "get-report pending"; "get-report complete"; "maps the complete fixture to surface, pitch, ridge+hip, eave+rake, valley and facets"; "get-report with unsupported units returns failed unsupported_units".
  - API: `apps/api/test/proposals.test.ts`: "repricing a sent proposal leaves it untouched and returns a new draft with revised true and a new number".
- **One `exact_report` usage event at cost**
  - Integration: `apps/api/test/exact-report-poll.test.ts`: "one usage row at the report cost, even if completed twice"; "an unreadable cost bills the quoted max, never zero".
  - Database: `packages/db/test/usage.test.ts`: "writes once per (kind, refType, refId)"; `apps/api/test/report-usage.test.ts` (usage becomes billable meter and invoice rows).
  - Adapters: `apps/api/test/eagleview.test.ts`: "get-report complete without a readable cost gives costCents null, never 0".
- **An uncertain order needs attention and is not re-ordered**
  - Integration: `apps/api/test/exact-report.test.ts`: "an uncertain order goes to attention and is never called again".
  - Adapters: `apps/api/test/eagleview.test.ts`: "place-order with an empty ReportIds throws ExactOrderUncertainError"; "place-order on a 500 throws ExactOrderUncertainError"; "place-order on a thrown fetch (timeout) throws ExactOrderUncertainError and fetch is called once for the order (no retry)".
  - Fakes: `apps/api/test/estimator-fakes.test.ts`: "orderUncertainNext makes exactly one order throw ExactOrderUncertainError".

## Proposal
- **Three options from the default templates, prices equal the engine's**
  - Unit: `packages/shared/test/tiers-templates.test.ts`: "the three defaults parse"; `packages/shared/test/tiers-price.test.ts`: "Good equals calculateQuote exactly"; "Better adds the two add-on lines with the expected quantities"; "totals reconcile".
  - API: `apps/api/test/proposals.test.ts`: "builds three options equal to priceTier for each default template"; `apps/api/test/tier-templates.test.ts`: "a company with nothing saved sees the three defaults".
  - Web: `apps/web/test/proposals.test.tsx`: "live totals equal priceTier"; `apps/web/test/e1-routes.test.tsx`: "/estimator/proposals/p1 shows the proposal".
- **Turning an option off and editing add-ons re-prices**
  - API: `apps/api/test/proposals.test.ts`: "patch re-prices: turning off the better option and changing good wastePercent updates the good total and calculation"; "a disabled template stays stored with enabled false and its tier is omitted from the enabled totals"; `apps/api/test/proposal-routes.test.ts`: "disables an option, keyed by option id"; "changing the waste re-prices".
  - Web: `apps/web/test/proposal-option-card.test.tsx`: "toggles enabled"; "adds, edits and removes add-ons"; "commits waste on blur and re-prices"; `apps/web/test/proposals.test.tsx`: "editing PATCHes"; `apps/web/test/proposal-window.test.tsx`: "patches the option that changed".
  - Unit: `packages/shared/test/tiers-price.test.ts`: "taxable add-ons are taxed, non-taxable add-ons are not"; "a zero-quantity add-on is skipped but later add-ons keep their original index".
- **The financing line appears only with APR and term set**
  - Unit: `packages/shared/test/tiers-finance.test.ts`: "matches the amortization formula"; "0% APR is ceil(P/n)"; "rounds up, never down".
  - API: `apps/api/test/proposals.test.ts`: "monthlyEstimateCents is null without APR and term and equals monthlyPaymentCents(total, 999, 120) when set"; "a 0 percent APR gives total/term"; `apps/api/test/proposal-pdf.test.ts`: "financing line only with terms and a monthly estimate".
  - Web: `apps/web/test/homeowner.test.tsx`: "shows the financing line".

## Send
- **The 3-click Playwright run passes**
  - e2e: `apps/web/e2e/estimator.spec.ts`: "typed address to sent in 3 clicks".
  - Web: `apps/web/test/estimator.test.tsx`: "Make proposal posts measure, build and send in order and opens the review"; "a typed address sends the address and the new customer with askedByText"; `apps/web/test/measure.test.tsx`: "Make proposal builds, sends and lands on the approval"; "a double click builds and sends once".
- **The text goes through the send gate with the link**
  - Integration: `apps/api/test/proposal-send.test.ts`: "POST /send drafts a task whose step previews the tier totals and the estimate basis"; "one text goes out with the link; the proposal is sent, the job is at Proposal, and one sent event is recorded"; "the stored link hash is the sha256 of the token in the text, and the plain token never reaches a log"; "in quiet hours the text is scheduled; when the dispatcher sends it the proposal becomes sent"; "a task whose text was edited to drop {link} is refused at the edit with the plain sentence".
  - Unit: `apps/api/test/proposal-send-unit.test.ts`: "builds the proposal link from the base URL and the token"; "fills the first name, company, address and link of the default template"; `packages/shared/test/steps-e1.test.ts`: "validate refuses a body without {link} with the exact sentence"; "preview names the customer, shows the three tier totals and a rendered sample with a link".
  - Web: `apps/web/test/e1-review-previews.test.tsx`: "send_proposal step shows Text the proposal to Maria with the totals and the Estimate line".
- **No consent: blocked with the plain reason**
  - Integration: `apps/api/test/proposal-send.test.ts`: "a customer without texting consent is blocked with the gate reason, and the proposal goes back to draft".
- **The job moves to Proposal**
  - Integration: `apps/api/test/proposal-send.test.ts`: "one text goes out with the link; the proposal is sent, the job is at Proposal, and one sent event is recorded".

## Homeowner page
- **Opens on phone without login**
  - API: `apps/api/test/estimator-skeleton.test.ts`: "GET /api/public/proposals/x without a session is 404, not 401"; `apps/api/test/proposal-public.test.ts`: "the token answers the homeowner view without a session, with no prices or customer ids, and the no-store headers".
  - Web: `apps/web/test/e1-routes.test.tsx`: "/p/abc renders without a session and without the shell"; `apps/web/test/homeowner.test.tsx`: "renders the three options"; "sets noindex".
  - e2e: `apps/web/e2e/homeowner.spec.ts`: "the homeowner signs with the keyboard only"; `apps/web/e2e/phone.spec.ts`: "the proposal view fits the phone".
- **View events counted**
  - API: `apps/api/test/proposal-public.test.ts`: "two views count twice, set viewed once, and leave one \"opened the proposal\" activity"; "a view with an option records option_viewed".
  - Web: `apps/web/test/homeowner.test.tsx`: "the view event is posted once per load"; `apps/web/test/proposal-window.test.tsx`: "shows how often it was opened".
- **Sign with typed name (keyboard only) gives a signed record with both hashes**
  - API: `apps/api/test/proposal-sign.test.ts`: "a signature is recorded with the document hash, the consent text, the raw ip and user agent; the job is Won with the chosen total"; "a second sign is a 409 and still one signature row"; "two signs at once: exactly one 200 and one 409"; "consent missing or false"; "empty names and a missing option"; "a tiny PNG without a prefix is accepted and its hash stored"; "the 11th attempt on one token within an hour is a 429".
  - Unit: `packages/shared/test/proposals.test.ts`: "canonicalJson sorts keys recursively and keeps array order"; "signedDocument changes when the chosen option total changes"; "consent and estimate clause text match the brief exactly".
  - Web: `apps/web/test/homeowner.test.tsx`: "sign with keyboard only posts the exact body"; "sign shows validation errors before posting"; "the drawn signature path posts a PNG"; "consent and clause text match the legal text".
  - e2e: `apps/web/e2e/homeowner.spec.ts`: "the homeowner signs with the keyboard only".
- **The signed PDF is stored and downloadable**
  - API: `apps/api/test/proposal-public.test.ts`: "the signed copy is a 404 until it is ready"; `apps/api/test/proposal-pdf.test.ts`: "signature page"; `apps/api/test/estimator-fakes.test.ts`: "put then get round-trips bytes and returns a copy" (object store fake).
  - Web: `apps/web/test/homeowner.test.tsx`: "an already signed proposal shows the signed state" (renders the download link).
  - GAP: the stored-and-downloaded path (R2 put on sign, `signed.pdf` returns the bytes) belongs to T13 (`apps/api/src/estimator/signed-pdf.ts`) and its tests merge with that branch; confirm them here when T13 lands. The e2e run does not wait for the PDF (`pdfReady` may be false). Real R2 is in the manual section below.
- **The job is Won with the chosen value**
  - API: `apps/api/test/proposal-sign.test.ts`: "a signature is recorded with the document hash, the consent text, the raw ip and user agent; the job is Won with the chosen total"; "other proposals of the same job become replaced".
  - Web: `apps/web/test/e1-today-signed.test.tsx`: "lists signed proposals".
- **Decline records the reason**
  - API: `apps/api/test/proposal-public.test.ts`: "decline stores the reason; a reason over 500 characters is a 400".
  - Web: `apps/web/test/homeowner.test.tsx`: "decline with reason posts it"; "decline with no reason posts an empty body".
- **An expired link shows the plain page**
  - API: `apps/api/test/proposal-public.test.ts`: "after valid_until it is readable as expired; 30 days later it is gone (410 with the phone)"; "a replaced proposal is gone (410)"; `apps/api/test/proposal-sign.test.ts`: "signing after valid_until is a 409 with the plain sentence".
  - Web: `apps/web/test/homeowner.test.tsx`: "an expired proposal shows the expired state"; "a gone link shows the plain message".
- **Another company's token never resolves; the public API is rate limited**
  - API: `apps/api/test/proposal-public.test.ts`: "an unknown token is a 404 with no hint, signed out or in another company"; "a post with the app origin works; one from another origin is a 403"; `apps/api/test/estimator-skeleton.test.ts`: "public routes are rate limited per IP: the 61st request is 429".

## Settings
- **Templates, financing and estimate settings save**
  - API: `apps/api/test/tier-templates.test.ts`: "the owner saves changes and GET returns them"; "bad templates are refused and name their field"; "office can read but not save; a rep can do neither"; "a save is returned by the next GET"; "bad values are refused and name their field"; "office reads but cannot save; a rep can do neither".
  - Unit: `packages/shared/test/tiers-templates.test.ts`: "invalid templates are refused with paths"; "boundary values are accepted".
  - Web: `apps/web/test/settings-estimator.test.tsx`: "tier save sends the shared schema shape"; "financing save sends apr in basis points and term"; "financing needs both or neither"; "estimate save sends the settings"; "estimate rejects 181 valid days"; "aerial switch is shown when configured and sends aerialMeasure on save"; `apps/web/test/e1-routes.test.tsx`: "Settings Prices shows the three E1 sections".
- **`prices_and_tiers` turns done**
  - API: `apps/api/test/tier-templates.test.ts`: "is done only when both the pricebook and the tiers are saved"; "tiers alone are not enough".
  - Web: `apps/web/test/settings-estimator.test.tsx`: "setup row links to prices".

## UI rules
- **Copy-rules tests pass**
  - Web: `apps/web/test/copy-rules.test.ts`: "uses no technical words"; "uses no enum tokens"; "names vendors only where connecting accounts or paying"; "finds strings in every copy file".
- **12px test passes**
  - Unit: `packages/ui/test/min-font-size.test.ts`: "only a var(--font-size-*) token passes; any other var() is reported"; "checks the definition of every --font-size-* token, so the var() passthrough is honest"; `packages/ui/test/tokens.test.ts` (the `--font-size-min` token is 12px).
- **axe tests pass**
  - e2e: `apps/web/e2e/a11y.spec.ts`: "estimator has no serious accessibility violations"; "measure view has no serious accessibility violations"; "proposal view has no serious accessibility violations"; "homeowner page has no serious accessibility violations".
  - e2e (phone): `apps/web/e2e/phone.spec.ts`: "the proposal view fits the phone".
- **"Estimate" appears on every instant price**
  - Web: `apps/web/test/measure.test.tsx`: "shows the Estimate label and the attribution line"; `apps/web/test/proposal-option-card.test.tsx`: "labels estimates only when the basis is estimate"; `apps/web/test/e1-job-proposals.test.tsx`: "shows Estimate on instant totals and not on exact ones"; `apps/web/test/e1-review-previews.test.tsx`: "exact basis shows the exact line".
  - API: `apps/api/test/proposal-pdf.test.ts`: "every total says Estimate when basis is estimate"; "is a PDF with the number and the estimate wording".
- **No vendor names outside the allowed copy files; the footprint attribution lives in `copy/legal.ts`**
  - Web: `apps/web/test/copy-rules.test.ts`: "names vendors only where connecting accounts or paying"; `apps/web/test/measure.test.tsx`: "shows the Estimate label and the attribution line" (reads `legal.footprintAttribution`).

## Manual (Task 22)
Spec section 10 "Manual smoke". Run by the owner or Task 22 with real accounts; not run in CI.
- **EagleView sandbox order and Property Data on a documented Omaha address.** Set `EAGLEVIEW_CLIENT_ID`, `EAGLEVIEW_CLIENT_SECRET`, `EAGLEVIEW_ENV=sandbox` and a real `EAGLEVIEW_PRODUCT_ID`. Price and order an exact report, then poll to complete; also request an aerial measure through Property Data. Record the address, the report id and the result.
- **R2 upload and download.** Set the four `R2_*` values, sign a proposal, and download the signed PDF from the owner view and from the homeowner link.
- **One real text with a real link on a test phone.** With texting registered, send one proposal from a real company to a test phone, open the link on that phone, and sign with the keyboard.

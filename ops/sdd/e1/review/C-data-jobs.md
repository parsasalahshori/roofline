# E1 whole-branch review — C: schema, migrations, jobs, providers, config

Reviewer C, read-only, worktree `/home/user/wt/e1-review` at b1a4980 (diff `origin/c1-crm..HEAD -- apps packages`).
Rulings EA–EP and AY were treated as decided, not reported. Nothing was run against a database or a provider.

Checked and found correct: composite FKs and `UNIQUE (company_id, id)` on all nine tenant tables. RLS is enabled, forced
and has `tenant_isolation` on all nine, and all nine are in `TENANT_TABLES`. The `app_system` column grants
(proposals 5 columns, exact orders 4) each come with `app_system_all`. The sequence grant for the bigserial is in place.
The `proposals.link_token_hash` unique index is used for the token lookup, and drafts get a random placeholder hash, so the
unique index never collides. `proposal_events (proposal_id, at)` has an index, and so has `building_footprints` (GIST on
`geom`, btree on `state`). The CHECKs match the route rules for pitch, overhang (0.1 step) and valid days. The tier
highlights cap is 4. The footprint loader is safe to retry: the claim deletes the state's old rows in one transaction,
failure clears its partial rows, the temp dir is removed in `finally`, it streams through yauzl and stream-json, and only
`FOOTPRINT_LOAD_FAILED_PLAIN` is stored. The EagleView, R2 and object-store calls happen outside transactions. The
exact-order claim (priced→ordering) commits before the provider call. `completeExactReport` claims waiting→complete before
it writes, and `recordUsage` is idempotent on the report id. `signed-pdf` uses a deterministic key, has a singleton key
per proposal, and rolls back on an attach race. Config: EagleView is both-or-none and R2 is all-or-none.
`FAKE_PROVIDERS` is refused in production. EagleView stays off while `EAGLEVIEW_PRODUCT_ID` is 0. The tests and the e2e
stack use fakes.

## Critical

### C1. `footprintsNear` cannot use the GIST index: every measure scans the whole global footprint table
`packages/db/src/repos/measurements.ts:116`: `where ST_DWithin(geom::geography, pt::geography, 40)`. The only spatial
index is `building_footprints_geom_gist` on `geom` (0015, the geometry type). PostGIS cannot use a geometry GIST index
for a predicate on `geom::geography`, and no index on `(geom::geography)` exists (no "geography" appears in any
migration). So `POST /api/measurements`, the "type an address" hot path, runs a sequential scan. It computes a geography
distance for every row of `building_footprints`, a table holding every loaded state (about 11M rows for Texas alone, and it
grows with each state a company is in). The test fixtures hold a few dozen rows, so CI cannot show this.
- Trigger: the first company in TX or CA measures a home after its state loads. The request takes seconds to minutes and
  holds a tenant transaction open the whole time.
- Fix: add an index-usable bounding-box prefilter and keep the exact geography test, e.g.
  `where geom && ST_Expand(pt, 0.001) and ST_DWithin(geom::geography, pt::geography, r)` (0.001° ≈ 111 m of latitude,
  which covers 40 m at US latitudes). Another option is a new migration with
  `create index ... using gist ((geom::geography))`. That migration would need a number after 0016 that C1 and E1 have not
  used, so the prefilter is the cheaper fix. Add an `EXPLAIN` assertion in footprints.test that the plan uses
  `building_footprints_geom_gist`.

## Important

### I1. Signed PDFs that fail 5 times are never made, and nothing re-queues them
`apps/api/src/estimator/signed-pdf.ts`, `apps/api/src/public/proposal-sign.ts:111`, `apps/api/src/jobs/worker.ts` (SCHEDULES).
The only thing that queues `signed-pdf` is the sign route, after the signature commits. Its retries (retryLimit 4, backoff
from 30 s) are used up in about 7.5 minutes. No schedule looks for `proposal_signatures.pdf_file_id IS NULL`. Spec §529
says production without R2 "signed PDFs wait (the signature record is saved regardless)". In fact they never get made:
the signature has no `pdf_sha256`, `signed.pdf` returns 404 forever, and the homeowner email never goes out.
- Triggers:
  - an R2 outage of more than about 8 minutes;
  - a DB blip on `deps.jobs.send` after the sign commit (the homeowner gets a 500, and a retry gets 409 "already
    signed");
  - R2 unset in production (warning only, `deps.ts:116`);
  - a missing or mismatched drawn PNG (Ruling EP: "the job retries", but only 5 times).
- Fix: add a schedule (e.g. `signed-pdf-sweep`, every 10 min) that lists the companies with a signature lacking a PDF
  older than 5 minutes and sends `signed-pdf` with `singletonKey: proposalId`. The listing needs either a narrow
  `app_system` column grant on `proposal_signatures (company_id, proposal_id, pdf_file_id, signed_at)` plus
  `app_system_all`, or a per-company tenant query driven by an existing fan-out.

### I2. Production without R2 blocks every drawn-signature signing (the spec says the signature is saved regardless)
`apps/api/src/public/proposal-sign.ts:79-81` with `apps/api/src/providers/object-store.ts:27`. In production with no R2
settings, `createObjectStore` returns `UnconfiguredObjectStore`, whose `put` throws. Config allows this, with only a
startup warning (spec line 243: "a startup warning, not a failure, in E1"). The sign route puts the PNG before the
transaction, so a homeowner who uses the optional pad gets an error and the signature is not saved. Spec §529 says it is
saved regardless.
- Trigger: production deploy before the owner's R2 to-do is done. A homeowner draws a signature, then taps Sign.
- Fix (keeps Ruling EP when R2 is set): when `!deps.objectStore.configured`, either refuse at startup in production (the
  spec's later step), or have the public page hide the pad and the route ignore `drawnSignature`. With I1's sweep, the
  PDFs are then made once R2 is configured.

### I3. A paid EagleView order's report id is lost if the waiting write fails, and the order is never billed or polled
`apps/api/src/estimator/exact-report.ts:152-165`. The `try` wraps both `deps.exactReports.order(...)` and the
`moveExactOrder(... 'ordering' → 'waiting', { providerReportId })` write. If the provider call succeeds and the DB write
throws (pool timeout, failover, a serialization error), the catch moves the order to `attention` (UNCERTAIN) and drops
`reportId`. That order:
- is never polled (no `provider_report_id`);
- never creates the exact measurement;
- never records the `exact_report` usage event.

Roofline pays EagleView and never bills the company. The logged error is the DB error, which does not carry the report id.
- Trigger: any transient DB error in the milliseconds after a successful PlaceOrder.
- Fix: put only the provider call in the `try`. After success, retry the waiting write a few times. If it still fails,
  log `orderId` and the report id (our ids, not provider text) through `reportJobError` before throwing, so the order can
  be recovered by hand. Better still, store the id with `set: { providerReportId }` in the attention move as well, so the
  poll or an operator can pick it up.

### I4. A proposal text blocked or failed later by the dispatcher leaves the proposal stuck in `ready`, with its step `done`
`apps/api/src/messaging/dispatcher.ts:190-207`. For a parked `send_proposal` step (a text held for quiet hours), the
dispatcher settles the proposal only when `counts.sent === 1`. In every other final state it finishes the step through the
batch rule: `done` unless a retryable refusal exists. This applies when the held text is later blocked (STOP received
overnight, consent removed, registration suspended), permanently failed, or marked unconfirmed. The proposal stays
`ready` ("Waiting for your OK") with no open task, and the owner sees a finished task. The step handler's own rule
(`send-proposal.ts:229-237`) is that a blocked or failed text puts the proposal back to `draft` and the step needs
attention with the reason. The dispatcher path skips that.
- Trigger: the owner approves at 9:30 PM, the text is scheduled for 8 AM, and the customer texts STOP overnight. At 8 AM
  the dispatcher blocks it, the step reads `done`, and the proposal stays `ready`. A `ready` proposal also cannot be edited
  (`updateDraftProposal` needs `draft`).
- Fix: in `settleParkedStep`, when `step.type === 'send_proposal'` and `counts.sent === 0` (with no scheduled or queued
  text left), run `setProposalStatus(['ready'] → 'draft')` and finish the step as
  `needs_attention`, `{ sent: 0, ... }`, `errorPlain: stepTextReason(...) ?? fallback`, in the same transaction.

### I5. Exact measurements show, and can be overwritten by, instant-estimate numbers
`packages/db/src/repos/measurements.ts:208` (`getMeasurement`) and `:232-292` (`updateMeasurement`).

`getMeasurement` always rebuilds `estimate` with `instantEstimate(outline, pitch, overhang, valley)`, also for
`kind = 'exact'`. The EagleView `surface_sq_ft`, `edge_ft` and `ridge_ft` that `completeExactReport` stores are never
shown: the measure window shows an outline × pitch surface for the exact measurement.

`updateMeasurement` has no kind guard, and an exact measurement is unlocked until a proposal from it is sent. So a PATCH
(a pitch nudge or a structure toggle in the measure window) overwrites the stored EagleView surface, edge and ridge with
instant values. The row keeps `kind 'exact'` and `method 'eagleview'`. Proposals then priced from it (via
`getMeasurementBasics`, which reads the stored columns) carry basis `exact`, with no "Estimate" label, on estimated
numbers.
- Trigger: open the new exact measurement in the measure window and change pitch or included structures.
- Fix: in `getMeasurement`, for `kind === 'exact'` use the stored surface, edge, ridge, valley and pitch. In
  `updateMeasurement`, return `'locked'` (409) for an exact measurement, or turn the edit into a new `estimate`-kind
  measurement.

## Minor

### M1. Lock order: sending a revised proposal and signing the old one lock the same two proposals in opposite order (deadlock)
- The send side (`proposal-sent.ts:26,48`), reached from the step handler and from the dispatcher (dispatcher order: task →
  P_new → P_old), locks P_new with `markProposalSent` and then P_old with `markReplacedProposal`.
- The sign side, `signProposal` (`proposal-public.ts:207`, `:263-272`), locks P_old with `FOR UPDATE`, then the job, then
  updates every other open proposal on the job (P_new, `ready`).

PostgreSQL aborts one side with 40P01. If the sign side is aborted, the homeowner gets a 500. If the send side is aborted,
the step is retried after the text already went out.
- Trigger: the homeowner signs the old link in the same moment the revised proposal's text settles.
- Fix: one order for both paths. For example, in `settleSentProposal`, lock the job's open proposals
  (`select ... where job_id = $1 order by id for update`) before `markProposalSent`, and do the same in `signProposal`
  before its updates.

### M2. No index for the exact-report fan-out
The `companiesWithWaitingExactOrders` query (`packages/db/src/system/exact-report-fanout.ts:11`) and
`listWaitingExactOrders` filter on `status = 'waiting'` and `last_polled_at` every 10 minutes. `exact_report_orders` has
only the PK and the two uniques, so each run is a full scan, which grows with every order ever placed. Fix (next free
migration): add `create index exact_report_orders_waiting_idx on exact_report_orders (status, last_polled_at)`, or a
partial index `where status = 'waiting'`.

### M3. `footprints-load` runs under pg-boss's default 15-minute expiry
`apps/api/src/jobs/queue.ts:13` sets no `expireInSeconds`, so the default is 900 s (pg-boss 12: `resolveWithinSeconds`,
"handler execution exceeded"). A real state download plus millions of inserts takes far longer. Each large load is timed
out and retried while the first handler keeps running unaborted. The retry finds a fresh `loading` claim and completes at
once, so pg-boss's record is wrong. The orphaned run's own failure is never reported, because its `meta.lastAttempt` is
false. Fix: give the `footprints-load` queue (or its send) `expireInSeconds` near `STALE_LOADING_MS` (6 h), which
pg-boss's 24 h cap allows.

### M4. A home in a state with no Microsoft file queues a job that fails 5 times on every measure
`apps/api/src/estimator/measure.ts:222` sends `footprints-load` for any `property.state` whose status is not `ready`. For
example PR, GU, or a free-text state from an import. `loadFootprintState` calls `deps.footprints.stateFileUrl(s)` before
its `try` (`footprints-load.ts:169`), and that throws `FootprintsUnavailableError`. pg-boss retries it 4 times, and each
later measure there queues it again. Fix: in `measureProperty`, send the job only when `state` is in `STATE_FILE_NAMES` /
`STATE_CODES`. In the loader, return without throwing for an unknown state.

### M5. A `PROPOSAL_LINK_BASE_URL` on another origin breaks signing, and config accepts it
`apps/api/src/config.ts:184` accepts any http(s) URL. But `blockCrossSiteMutations(config.APP_ORIGIN)` (`app.ts:220`)
refuses non-GET requests whose `Origin` is not `APP_ORIGIN`. A homeowner page served from the link origin (spec Decision
13's future short domain) therefore gets 403 on `/api/public/proposals/:token/sign` and `/decline`. This is the wave-3
carry, still open. Fix: a `superRefine` requiring `new URL(PROPOSAL_LINK_BASE_URL).origin === APP_ORIGIN` until the
public routes accept that origin, or let `blockCrossSiteMutations` also accept the link origin for `/api/public/`.

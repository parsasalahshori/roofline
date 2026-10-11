# Merge notes: sibling 1, F3 Task 9 (branch f3-t9)

Group check by Opus contact 23 (workflow run wf_bb05ddd5-f24). Base f3-setup baf4c93.

Post-run fix by sibling 1: 40df7ef applies the controller-relayed brief amendment (InlineJobs.drain pushes EVERY throw to `errors`; always-throwing handler -> errors.length 5; throw-twice-then-succeed -> 2 errors). The team built against the pre-amendment brief.

## Merge notes

There is only one task in this group: T9 (f3-t9, baf4c93..b70976f, two commits, worktree clean). It has nothing to merge against inside the group.

Merging into f3-setup: since baf4c93, f3-setup has gained T7 (76aa441 / merge 9760679) and T11 (9618f3b, e689d8c, d33ecba / merge 9a469c8). Those changes touch hooks/twilio.ts, imports/{normalize,plan}.ts, packages/db repos/{delivery,inbound,messages}.ts, system/routing.ts, shared consent.ts, and the tests delivery-reports, import-plan, twilio-hooks and consent. None of these files overlap T9's 49 changed files, so `git merge f3-t9` into f3-setup should be textually clean.

Things to check after merging:
- The new T11 tests (delivery-reports.test.ts, twilio-hooks.test.ts) build deps only through makeTestApp(overrides) and `{ ...t.deps, sms }`. T9 widens TestApp/AppDeps and wires the fakes inside makeTestApp, so those tests typecheck unchanged.
- The only buildDeps callers are server.ts, apps/worker/src/index.ts and config.test.ts, and T9 updates all three. Nothing in apps/api/src/scripts calls buildDeps.
- Run `/home/user/roofline/ops/bin/slot npm run typecheck` and `/home/user/roofline/ops/bin/slot npm run lint`, then push through ci-check: pgboss.test.ts, jobs.test.ts and config.test.ts are DB-backed.

Fix before T24 is briefed or started: the InlineJobs `errors` meaning (important issue above). It is a small change confined to apps/api/src/jobs/queue.ts and apps/api/test/jobs.test.ts, so it can go in as a follow-up commit on f3-t9 before the merge, or as a fix on f3-setup.

Interfaces T9 publishes for later tasks; their names and signatures match the brief exactly:
- Factories: createGeocoder, createBillingProvider, createRegistrar, createSmsAdapter.
- Adapter stubs that later tasks replace: geocodioFor, stripeFor, twilioSmsFor, twilioAccountsFor, twilioBrandsFor.
- Fakes: FakeGeocoder, FakeBillingProvider, FakeTextingRegistrar (with fakeSid, failNext(method, what), setBrand, setCampaign).
- Jobs: JOB_NAMES, JobData, JobMeta, JobQueue, PgBossJobs, ensureJobQueues, InlineJobs.drain(deps, handlers?, maxRuns?), JOB_HANDLERS.
- SCHEDULES: the five new crons, in the brief's order.
- Route, hook, job and scheduler stubs: billingRoutes, setupRoutes, textingRoutes, importRoutes, stripeHooks (raw parser), twilioRegistrationHooks, policyPages, policyUrls, readOnlyGuard, runImport, advanceRegistration, continueRegistration.
- Helpers: billingConfig, hasPaymentMethod.
- ESLint: the db/system allowlist now includes account/** and public/**, and boundaries.test.ts covers it.

Each later task (T13, T14, T16-T28) should replace only its own stub file, so stub replacements should not conflict with each other.

Copy and lint: no web/UI files are touched. The API messages "Billing isn't set up.", "Address lookup isn't set up." and "Texting registration isn't set up." match the brief. The report says typecheck and lint are clean, and CI run 38182758466 passed.

## Issues

- **important** (tasks 9, 24): InlineJobs.drain (apps/api/src/jobs/queue.ts, the catch block in drain) only pushes to `errors` when the last attempt throws. The brief requires every throw to be pushed to `errors`: "T24's crash test expects errors.length === 1 after one failed attempt", and an always-throwing job should end with errors.length === 5. jobs.test.ts was written to match the code instead of the brief. It asserts `errors` stays empty after two throws followed by a success, and that an always-throwing job ends with `toHaveLength(1)`. With this code, T24's crash test (one crash, then success on the retry) will see errors.length === 0 and fail.
  - Suggestion: Change the catch to `lastError = err; this.errors.push(err); if (!meta.lastAttempt) this.waiting.push({ ...job, attempt: job.attempt + 1 });`. Update the two jobs.test.ts expectations to `errors` of length 2 (throw twice, then succeed) and length 5 (always throws), and change the InlineJobs doc comment to match. If the controller would rather keep the last-attempt-only meaning, the T24 brief has to be changed before T24 starts. One of the two must change.
- **minor** (tasks 9): InlineJobs.send treats a send as a duplicate if any waiting job has the same singletonKey, whatever its queue name. pg-boss scopes singletonKey to one queue, so an 'import-customers' job and a 'texting-registration' job with the same key would wrongly collapse into one.
  - Suggestion: Compare on both values: `this.waiting.some((j) => j.name === name && j.singletonKey === singletonKey)`.
- **minor** (tasks 9): The header comment in apps/worker/src/index.ts is stale. It still says `deps.sms` is set by buildDeps "to the disabled provider until F3 adds Twilio", but sms now comes from createSmsAdapter (the fake, Twilio, or the disabled adapter). It also lists only the first three SCHEDULES, and one rewrapped comment line is far over the usual width.
  - Suggestion: Reword it to say deps.sms comes from createSmsAdapter, name the five new schedules (or point to SCHEDULES), and rewrap the long line.
- **minor** (tasks 9, 24, 27): jobs/queue.ts imports the value JOB_HANDLERS from handlers.ts, which imports imports/run.ts (T24) and account/texting/advance.ts (T27) as values. If those tasks later import a value from jobs/queue.ts (for example JOB_QUEUE_OPTIONS or InlineJobs), they create an ESM cycle through queue.ts.
  - Suggestion: Tell T24, T27 and T28 to send follow-up jobs only through deps.jobs and to import only types from jobs/queue.ts.
- **minor** (tasks 9): Brief signatures were pasted in as one-line declarations: `JOB_NAMES` and `JobName` share a line in queue.ts, and BillingProvider, Geocoder and the registrar interfaces are packed into a few lines with the closing brace on the last member's line. Lint and CI pass, but this does not match the formatting used in the rest of the repo.
  - Suggestion: Optionally expand them to one member per line when a later task touches these files. Not a merge blocker.

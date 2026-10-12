### F3 integration review fixes, group B: API/db fixes (import consent locking and opt-outs, usage reporting needs a live subscription, import job sweeper, hosted website URL)

**Base:** f3-setup 330ca23 (branch f3-review-b). Source: the F3 integration review (sibling 3, workflow wf_4ad50b4d-a20); each finding below was verified by an Opus verifier against the code. Apply the VERIFIED FIX (it supersedes the reviewer's first proposal). Keep changes minimal and inside the files named. Add the tests named. Ruling AO: no new migrations.


## R6 (consent-sendgate/F3-CONSENT-2; verdict amended, important; tasks T24, T10)

**Where:** packages/db/src/repos/import-apply.ts

**Problem:** applyImportChunk reads matched customers (lines 250-258) and the opt-out flags (existingIndexFor, line 239) without the per-customer texting lock and without FOR UPDATE. It then writes smsConsentStatus from that stale read (lines 335-349). The STOP path (handleInbound, then lockRecipients, then revokeConsentByText) and the carrier opt-out path (recordCarrierOptOut) lock customers first so that a concurrent decision finishes first. The import chunk transaction runs for seconds and does not take part in that protocol.

**Failure scenario:** A chunk reads customer C as status none or express. C's customer texts STOP from a second number P2, which is not their primary number, and /sms commits status revoked plus an opt_outs row for P2. The chunk then writes express or attested over revoked, with source import. C's primary number P1 is not in opt_outs, so the gate allows texts again to someone who just opted out. This breaks the rule that an import never raises from revoked.

**Verifier:** The finding is real. In packages/db/src/repos/import-apply.ts, applyImportChunk locks only its own import_rows (FOR UPDATE SKIP LOCKED, around lines 221-234). It then reads the matched customers in two places, both plain SELECTs that take no row lock and no texting lock:
- existingIndexFor (imports.ts:161-181) reads status, doNotContact and the opt_outs rows.
- The `current` select at lines 250-258 reads the customers again.

decideConsent/importConsent then works from that snapshot (none or express goes to express or attested). The UPDATE at about lines 335-349 writes absolute consent columns, so it does not re-check what is there now.

The two revoke paths serialize only with each other and with sends:
- revokeConsentByText (inbound.ts:142) takes lockRecipients, then lockConsent FOR UPDATE, then opt_outs.
- recordCarrierOptOut (opt-outs.ts:43) takes the same locks in the same order.

The import chunk takes none of these locks, so the lost update is real under READ COMMITTED. Timeline: the chunk reads C as none. A STOP from P2 commits C as revoked, plus an opt_outs row for P2. The chunk's UPDATE then runs; if the STOP is still in flight it waits on the row lock and runs after the commit. Either way it overwrites C with express or attested and source import. P1 has no opt_outs row and the status is no longer revoked, so the send gate allows texting P1. This breaks importConsent's rule that a revoked customer is never raised.

Severity stays important. The window is narrow (a chunk of up to 250 rows between its read and its write), but the result is texting someone who opted out. No ruling or deferred minor in the ledger covers this, and the fix needs no migration (Ruling AO).

The same unlocked read-modify-write also loses concurrent office edits to phones, emails and names, because mergeRow builds on the stale arrays. The fix below closes that too.

On the proposed fix: the advisory lockRecipients call is optional. Both revoke paths lock the customers rows FOR UPDATE in id order before they write, so a FOR UPDATE read in id order is enough to serialize with them. Using both is fine as long as the order stays advisory, then rows.

**VERIFIED FIX:** In packages/db/src/repos/import-apply.ts, applyImportChunk:

1. Lock the matched customers. After computing matchedIds, and optionally after `await lockRecipients(tx, ctx, matchedIds)` (import it from './inbound.ts'; it sorts the ids), change the `current` query to `.where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, matchedIds), isNull(customers.archivedAt))).orderBy(asc(customers.id)).for('update')`. This takes the locks in the same order as revokeConsentByText and recordCarrierOptOut (texting lock, then customers FOR UPDATE by id), before any customers write.

2. Rebuild the consent state from the locked rows, not from hitById:
   - Take `status` and `doNotContact` from `c`.
   - Recompute `optedOut` with a fresh query: `select phone_e164 from opt_outs where company_id = ctx.companyId and phone_e164 in (all e164 of the locked customers' phones)`, and set optedOut when any of the customer's phones is listed.

3. Handle a matched id that the locked query no longer returns (for example, it was archived in between). It must not silently fall through to `working.get(...) === undefined`, which pushes nothing for that row. The simplest option is to treat that row as a new customer (isNew with decideConsent(null, ...)), or to skip the row and leave its outcome null so the next run picks it up.

4. mergeRow and the final UPDATE then work from the locked rows. That also stops the import overwriting concurrent office edits to phones and emails.

Test to add (packages/db, DB-backed, like the T24 import tests):
- Import a customer C with phones [P1 primary, P2] and consent none.
- Start a transaction that runs applyImportChunk for a row matching C by P1, using two connections. Open tx A, which calls lockRecipients for C and runs revokeConsentByText for P2 but has not committed. Run applyImportChunk in tx B; it must block. Commit A, then let B finish.
- Assert C.smsConsentStatus is 'revoked' (source 'text'), not 'express'.
- A simpler sequential variant: stub or hook between existingIndexFor and the write is hard, so the two-connection version is preferred. Also assert that applyImportChunk run after a committed STOP leaves C revoked (the regression guard for the importConsent rule).


(Same issue also reported as tenant-db/TI-1; its verified fix for reference: In packages/db/src/repos/import-apply.ts, applyImportChunk:

1. Lock the matched customer rows. At lines 249-254, add `.orderBy(asc(customers.id)).for('update')` to the `current` select. This is the same lock order as lockConsent in inbound.ts:118-126. Under READ COMMITTED, a FOR UPDATE that waits behind a STOP returns the committed 'revoked' row.

2. Re-read opt-outs after the lock. Do not use `hitById.get(c.id)?.optedOut`. After `current` is loaded, select `optOuts.phoneE164` where the company matches and the phone is in the union of `current[*].phones[*].e164`. Set `state.optedOut = c.phones.some((p) => outs.has(p.e164))` from that fresh set. `status` and `doNotContact` already come from `c`, which is now the locked row.

3. Optional: to also serialize with sends deciding right now, call `lockRecipients(tx, ctx, matchedIds)` (exported from repos/inbound.ts) just before the FOR UPDATE select, never after it. This matches the inbound order: advisory lock first, then row lock. No WHERE status guard is needed once the rows are locked.

Test to add in packages/db (a DB test, to run in CI). Seed a customer with consent 'express' and phone P, and an import whose row matches P, with attestation set. In tx A, open a transaction that runs revokeConsentByText for P and the customer but does not commit yet. Start applyImportChunk in tx B. Assert that B blocks on the row lock: commit A, then await B. Assert the customer stays smsConsentStatus 'revoked' with source 'text', and the row outcome is 'updated' with consent 'revoked'.

Add a second case that runs the import first and holds tx B open. Then run the STOP and check that it waits and ends 'revoked'.)


## R7 (consent-sendgate/F3-CONSENT-1; verdict amended, important; tasks T23, T24, F2 customers repo)

**Where:** packages/db/src/repos/import-apply.ts

**Problem:** applyImportChunk (mergeRow at line 173, customer update loop at lines 335-349) adds a row's new phones to a matched customer who is revoked, do_not_contact or opted out. It never puts those numbers on opt_outs. F2's updateCustomer keeps the rule that an opted-out customer has every one of their numbers on the opt-out list (ensureOptOuts, customers.ts ~125 and ~452). The send gate checks the opt-out list by number, and only for the primary number, so the list is what keeps a person off when their customer record changes.

**Failure scenario:** Customer A has do_not_contact=true (or was revoked by a STOP). Their only number P1 is in opt_outs. An import row matches A by email and carries P2. A.phones becomes [P1,P2], but P2 is not in opt_outs. Later A is archived, or the office makes a second customer record. An import or a manual create then makes a new customer B with P2. The duplicate-phone check ignores archived rows, and B is created express or attested. The gate sees no opt_out for P2 and no flag on B, so the person who asked not to be texted gets texts.

**Verifier:** The finding holds. In packages/db/src/repos/import-apply.ts, mergeRow (lines 173-194) adds a row's new phones to a matched customer. The update loop (lines 335-349) then writes them with a plain UPDATE and nothing else. Nothing in applyImportChunk writes to opt_outs.

F2 sets a rule that such a customer has every number on the opt-out list:
- customers.ts:229 defines optedOut(row) as doNotContact || status === 'revoked'.
- customers.ts:443-453 says "a customer who is opted out must have every number on it". updateCustomer calls ensureOptOuts on all phones whenever `phones` changes for such a customer.
- createCustomer does the same at customers.ts:331.

Import is the one write path that adds numbers without this step. importConsent (shared/consent.ts:16) keeps a revoked or do-not-contact customer's status, so the matched customer stays opted out but the new number is not listed.

The send gate looks up opt-outs one number at a time (isOptedOut, messages.ts:139). The duplicate-phone check (customers.ts ~108) and existingIndexFor (imports.ts:170) both skip archived customers. Failure path:
1. A is do-not-contact or revoked, and A's number P1 is on opt_outs.
2. An import matches A by email and adds P2.
3. The office archives A.
4. A manual create, or a later import, makes customer B with P2. An import gives B express or attested consent.
5. The gate finds no opt_outs row for P2 and no flag on B, so B is texted. The person behind B had opted out under A.

This takes several steps, but it is a consent leak that F2's rule exists to prevent, so Important stands.

The proposed fix goes too far in one place: it also lists the new numbers when only s.state.optedOut is true. Ruling AM's optedOut means one of the customer's numbers has its own STOP row, while their status is not revoked. F2 does not extend opt-outs to a customer's other numbers in that case. Doing it here would block numbers the person never opted out, which neither F2 nor Ruling AM asks for. The trigger should be F2's own optedOut predicate: revoked or do_not_contact.

**VERIFIED FIX:** 1. In packages/db/src/repos/import-apply.ts, import ensureOptOuts from './customers.ts'. customers.ts does not import import-apply, so this creates no import cycle.
2. Right after the `for (const s of working.values())` update loop (line ~349), collect the numbers to list:
   `const outs = [...working.values()].filter((s) => s.dirty && (s.state.status === 'revoked' || s.state.doNotContact)).flatMap((s) => s.phones.map((p) => p.e164));`
   then `await ensureOptOuts(tx, ctx, outs, now);`
   - Do not include s.state.optedOut. A customer whose only opt-out is one number's own STOP stays per-number, as in F2 and Ruling AM.
   - One call for the whole chunk keeps the insert sorted, so it cannot deadlock. It does nothing for rows already on the list.
3. Add a db test in packages/db/test (import-apply), next to the existing applyImportChunk tests:
   - Seed customer A with do_not_contact = true and phone P1 on opt_outs.
   - Seed customer C with status 'revoked' and phone P3 on opt_outs.
   - Apply a chunk with two rows: one matches A by email and carries P2, the other matches C by email and carries P4.
   - Assert opt_outs rows exist for P2 and P4, each with keyword 'manual'.
   - Assert that A's do_not_contact and C's status are unchanged.
   - Negative case: a customer with status 'none' whose P5 has a STOP row (so optedOut is true) gets merged phone P6. Assert there is no opt_outs row for P6.


## R8 (billing/B1; verdict amended, important; tasks T20/T22/T19 (P3b))

**Where:** apps/api/src/jobs/scheduler/report-usage.ts:30

**Problem:** The usage reporter only checks that the company has a Stripe customer id (stripeCustomerIdFor, lines 30-31). Checkout creates and stores that customer (billing-routes.ts ensureCustomer + setStripeCustomerIfMissing) before the owner has paid or any subscription exists. From that moment the every-minute job sends all trial-period usage as meter events with timestamp=now and marks the batches reported_to_stripe_at. No subscription exists yet, so Stripe has nothing to attach those events to. The spec says usage during the trial is billed normally.

**Failure scenario:** A trial company sends 600 text segments over a week. The owner clicks Pick this plan, which creates the customer. Within a minute report-usage reports 600 segments to the roofline_sms_segment meter for a customer with no subscription (the owner is still on the Stripe page). The rows are marked reported and never resent. When the subscription is created, those 600 segments are not in its period, so they are never billed or counted against the plan's overage tier. An owner who abandons checkout also has their usage marked reported, though no subscription ever existed.

**Verifier:** The finding holds. apps/api/src/jobs/scheduler/report-usage.ts:30-31 checks only stripeCustomerIdFor (packages/db/src/repos/usage.ts:202). POST /api/billing/checkout (apps/api/src/account/billing-routes.ts:109-117) creates and stores the customer before Checkout is shown. The subscription appears only later, through customer.subscription.created (stripe-events.ts subscriptionUpdate). Owners usually spend more than a minute on the Stripe page, so the every-minute job sends all accumulated trial usage as meter events with timestamp=now, which is before the subscription starts, and marks the rows reported. Stripe adds up meter events into a subscription's period by event timestamp, so these events are never billed and never count toward overage. An abandoned checkout also marks its rows reported with no subscription at all. The T22 brief and plan do say only "no customer -> skip". But that was written when nobody knew the customer is created before the subscription (T19 vs T22, Ruling Z), and the spec rule "usage during the trial is billed normally" is broken, so this is a real cross-task problem. No ledger entry covers it.

The proposed fix needs two corrections:
1. Its `continue` skips the whole company, which would also hold back invoice items. Invoice items are fine without a subscription: Stripe keeps pending invoice items on the customer and adds them to the next invoice, which is the subscription's first one. Only the meter-event step should be gated.
2. The status check is right as written: companyStatusFor maps Stripe 'trialing' to 'active', so a checkout that kept the trial counts as live. Also, subscription.deleted clears stripe_subscription_id, so a canceled company correctly stops sending meter events.

Rows held back this way stay unreported, so companiesWithUnreportedUsage keeps returning that company every minute. That costs one cheap query and is acceptable.

**VERIFIED FIX:** 1. In packages/db/src/repos/usage.ts, add next to stripeCustomerIdFor (no migration):
`export async function meterTargetFor(tx, ctx): Promise<{ customerId: string | null; liveSubscription: boolean }>`
It selects companies.stripeCustomerId, stripeSubscriptionId and status for ctx.companyId. liveSubscription = stripeSubscriptionId !== null && status in ('active','past_due'), the same rule as repos/setup.ts:30 and hasPaymentMethod. Alternatively, extend stripeCustomerIdFor to return both values.

2. In apps/api/src/jobs/scheduler/report-usage.ts, read both values in the one withTenant call at line 30.
- Keep `if (customerId === null) continue;` as it is.
- Wrap only the meter-batch block (lines 33-43) in `if (liveSubscription) { ... }`. Do not call openMeterBatches without a live subscription, so no batch ids are assigned early. Assigning them would still be safe, but there is no need.
- Leave the invoice-item block (lines 45-54) unconditional: pending invoice items attach to the subscription's first invoice.
- Keep timestamp: now. Once the subscription exists, now falls inside its current period.
- Update the doc comment's step list.

3. Tests in apps/api/test/report-usage.test.ts:
- Change the existing fixtures to set stripe_subscription_id = 'sub_fake_1' and status = 'active' alongside cus_fake_1 (and cus_fake_2).
- Add test('meter usage waits for a subscription; invoice items do not'). Set Acme's stripe_customer_id = 'cus_fake_1', stripe_subscription_id null, status 'trial'. Record sms_segment 3 and exact_report 1 x 4500. Run reportUsage. Expect t.billing.meterEvents to be [], the sms row's reported_to_stripe_at and meter_batch_id to be null, and one invoice item created and marked. Then set stripe_subscription_id = 'sub_fake_1' and status = 'active' and run reportUsage again. Expect one roofline_sms_segment event with value 3, and the row marked reported.


## R9 (jobs-reliability/J2; verdict amended, important; tasks T23, T24, T9)

**Where:** apps/api/src/routes/imports.ts

**Problem:** The /start and /retry handlers commit the status change (uploaded->queued, failed->queued) first, then call sendJob (lines 218 and 232), which sends the pg-boss job with no error handling and nothing to recover from. The agent-step queue has a sweeper (sweep-queued) for this exact gap, but no scheduled job re-sends 'import-customers' for imports stuck in 'queued'. SCHEDULES has no import sweep.

**Failure scenario:** The owner clicks Start import. The transaction commits and the import is 'queued'. boss.send then throws (pg-boss or database blip, or a deploy restart between commit and send), so the API returns a 500. The import stays 'queued' forever with no job. Start returns 409 (already started) and Retry returns 409 (NOT_FAILED), because retryImport only moves failed to queued. The owner has no way to finish or cancel the import from the UI, and the setup checklist never completes. The job could also be lost if its pg-boss row is deleted.

**Verifier:** The finding is confirmed. In apps/api/src/routes/imports.ts, /start (line 218) and /retry (line 232) commit the status change to 'queued' inside withTenant, then call sendJob (lines 79-80, which is jobs.send('import-customers', ..., {singletonKey})) outside the transaction with no error handling. PgBossJobs.send (jobs/queue.ts) simply awaits boss.send. SCHEDULES in jobs/worker.ts has sweep-queued, but that covers agent steps only (tasks/). No schedule re-sends import-customers.

Once the import is stranded in 'queued', no path recovers it:
- startImport only moves uploaded to queued, so Start returns 409.
- retryImport only moves failed to queued, so Retry returns 409 NOT_FAILED.
- claimImport is only reached through the job.

A second stranding path makes this worse. A worker killed or expired mid-run, for example during a deploy on the last attempt, leaves the row in 'processing'. runImport's catch never runs in that case, so failImport is never called.

The ledger has no deferred minor or ruling covering this. The only sweep follow-up is for early_delivery_reports. The import can never finish or be retried, and the setup checklist's import step stays stuck. Severity stays important.

The proposed fix needs one correction. Re-sending for 'processing' rows after only "a few minutes" is unsafe. The queue policy is 'stately', which allows one queued job next to one active job. claimImport keeps 'processing' (it resumes the run), so a resend while the original run is still active can start a second concurrent run of the same import.

updated_at is a usable staleness signal. claimImport, saveImportProgress and finishImport/failImport all bump it, and no migration is needed (Ruling AO).

**VERIFIED FIX:** 1. Add apps/api/src/jobs/scheduler/sweep-imports.ts, modelled on sweep-queued.ts:
   - Use the app_system pool to list (company_id, id) from imports where either:
     - status = 'queued' and updated_at < now - 2 minutes, or
     - status = 'processing' and updated_at < now - (pg-boss job expiry, default 15 min, plus a margin; use about 30 minutes).
   - For each row, call deps.jobs.send('import-customers', { companyId, importId: id }, { singletonKey: id }).
   - Log each failure with reportJobError and continue, so the next tick retries it.
   - Return { resent }.
   - Optional: if a 'processing' row has been stale for much longer (for example 6 hours), failImport it with a plain message such as "This import stopped before it finished. Try again." Retry then becomes available, and a dead import does not get 5 fresh attempts every half hour forever.

2. Register it in SCHEDULES in apps/api/src/jobs/worker.ts: { name: 'sweep-imports', cron: '* * * * *', run: sweepImports }.

3. In routes/imports.ts, wrap `await sendJob(...)` in /start and /retry in try/catch. Log the error with reportJobError/describeErrorForLog and still return 202 with the view. The commit already happened, and the sweeper will hand the job over. This follows how routes/approvals.ts treats a refused enqueue.

4. Tests:
   - A db-backed test sweep-imports.test.ts:
     - An import left 'queued' with an old updated_at and no job sent: the sweep sends exactly one import-customers job with singletonKey = importId, and draining InlineJobs brings the import to 'done'.
     - A 'processing' import updated 1 minute ago is not re-sent.
     - A 'queued' import updated 30 seconds ago is not re-sent.
   - A route test: with a JobQueue whose send throws, POST /:id/start returns 202 and the import is 'queued'.


## R10 (texting-registration/TX-4; verdict confirmed, important; tasks T17, T27, T35)

**Where:** apps/api/src/account/texting-routes.ts:56-62 with apps/api/src/public/policies.ts:70-80

**Problem:** The 'Use the Roofline page' option fills the brand's website with the origin of the hosted privacy page (e.g. https://<slug>.<POLICY_PAGES_DOMAIN>). The company-host router answers every path other than /privacy and /terms, including /, with a 404 page. The website Twilio and the carriers vet is therefore a 404.

**Failure scenario:** POLICY_PAGES_DOMAIN is set and an owner with no website of their own leaves the box ticked, which is the default. The brand is submitted with website=https://acme.policies.example, and that root returns 404. Brand or profile vetting fails on the website, and plainRejection then tells the owner to 'use the Roofline page', which is the page that failed.

**Verifier:** I traced it in the code and it holds. In apps/api/src/account/texting-routes.ts:56-62, when useHostedPolicyPages is true and the website is empty, the route sets brand.website = new URL(policyUrls(config, slug).privacy).origin. The web form sends that flag by default when the prefilled website is empty (T35 brief line 20). With POLICY_PAGES_DOMAIN set, the origin is https://<slug>.<domain>. In apps/api/src/public/policies.ts:89-96, hostSlug matches that host and any path other than /privacy or /terms gets sendNotFound, so GET / returns 404. The brand sent to Twilio therefore names a website whose root is a 404. With POLICY_PAGES_DOMAIN unset, the origin is the PUBLIC_BASE_URL origin, which is the Roofline app itself and not a page about the company. The carriers vet the website for the business name and a privacy policy, which is the same check plainRejection's website rule describes. So the default path for an owner with no website is likely to be rejected. The rejection copy then tells the owner to "use the Roofline page", which is the setting they already had. This is not a known deferred minor; the ledger has nothing on it. The code follows the plan (line 2394) and the T27 brief (line 46) word for word, so this is a defect in the spec. It only shows up when T17's host router and T27's website fill run together. No API test covers useHostedPolicyPages=true: texting-submit.test.ts always sends false.

**VERIFIED FIX:** 1. apps/api/src/account/texting-routes.ts:60-61: fill the website with the full privacy page URL, not its origin. Use brandInput = { ...brandInput, website: policyUrls(config, company.slug).privacy }. That page returns 200 and shows the company's legal name, address and privacy text, which is what vetting checks, whether or not POLICY_PAGES_DOMAIN is set. Update the comment above it and record a ruling in ops/sdd/f3/progress.md that this departs from plan line 2394 and the T27 brief line 46.
2. Optional, in addition: in apps/api/src/public/policies.ts:91-95, answer GET / on a company host with 302 to /privacy, or a small 200 landing page with the company name and links to /privacy and /terms, so a bare origin someone typed in still works.
3. Tests: in apps/api/test/texting-submit.test.ts, add a case that posts { brand: { ...BRAND, website: '' }, useHostedPolicyPages: true }. Assert that the saved or submitted brand website equals policyUrls(config, slug).privacy, and that brandSubmissions()[0].website is that URL. If step 2 is done, add a case to apps/api/test/policy-pages.test.ts asserting that GET / with Host <slug>.<POLICY_PAGES_DOMAIN> returns 302 to /privacy, or 200.

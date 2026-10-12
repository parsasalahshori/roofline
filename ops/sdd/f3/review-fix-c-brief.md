### F3 integration review fixes, group C: Texting provider fixes (partial Twilio sids saved, fee after commit, no second number, 401/403/429 not a rejection)

**Base:** f3-setup 330ca23 (branch f3-review-c). Source: the F3 integration review (sibling 3, workflow wf_4ad50b4d-a20); each finding below was verified by an Opus verifier against the code. Apply the VERIFIED FIX (it supersedes the reviewer's first proposal). Keep changes minimal and inside the files named. Add the tests named. Ruling AO: no new migrations.


## R11 (texting-registration/TX-1; verdict amended, important; tasks T26, T27)

**Where:** apps/api/src/account/texting/advance.ts:46-100 (with apps/api/src/providers/twilio/brand-profile.ts:submitBrandFlow)

**Problem:** The Twilio ids from submitBrand (customer profile, trust product, brand) are saved only after the whole provider flow succeeds. They are saved inside the withRegistrationLock transaction, which rolls back if anything later throws, including the separate recordUsage call at line 90. Any failure part-way through submitBrandFlow also loses the ids. A RegistrarRejectedError thrown by an Evaluation (noncompliant) loses them too. The retry then sees null previous ids and creates everything again. Ruling AL (update the existing profile in place) is bypassed on that path.

**Failure scenario:** First submission. Twilio creates the customer profile, trust product and brand, and submitBrand returns. The recordUsage insert (a different pool) then fails, or the commit fails. The system transaction rolls back, so customer_profile_sid, trust_product_sid and brand_sid stay null and the job retries. The retry creates a second profile, trust product and brand, and Twilio bills the brand fee a second time. The same duplicate happens when a 5xx or timeout hits mid-flow, for example on the TrustProducts call after the CustomerProfile was created. The job runs up to 5 attempts, and the hourly poll in T28 re-runs a registration that has submitted_at set and no brand_sid, so one outage can leave several orphaned profiles. When the profile Evaluation comes back noncompliant, the created profile's sid is thrown away. After the owner fixes the form, the resubmit creates a fresh profile instead of updating the old one.

**Verifier:** The failure is real. In advance.ts:46-101 the whole of stage 1 runs inside one system-pool transaction (withRegistrationLock, packages/db/src/system/texting.ts:125-145). The Twilio sids are written only at line 70, after submitBrandFlow (brand-profile.ts:218-249) has made every one of its 12 or more sequential Twilio calls. Three things lose ids that Twilio already created:
(a) Any throw part-way through the flow. A timeout or 5xx becomes RegistrarUnavailableError (brands.ts:136-138) and advance.ts:77 rethrows it, so the CustomerProfile, TrustProduct or EndUsers created so far are never recorded.
(b) A noncompliant Evaluation. submitForReview (line 89) throws RegistrarRejectedError, and the catch at advance.ts:76-84 saves only the rejection fields. A profile that was just created and failed evaluation is therefore never saved. After the owner fixes the form, previous.customerProfileSid is still null, so createCustomerProfile runs again and the update-in-place path of Ruling AL is skipped.
(c) A recordUsage failure (line 89, a separate withTenant connection) or a commit failure after the brand POST. This rolls back brand_sid, and the retry POSTs a new BrandRegistration, which Twilio bills a second time.
The retry path is genuine. brandStageDue requires brand_sid to be null, which still holds after a rollback, and the job retries on a rethrow.
I downgraded the severity from critical to important for three reasons:
- Path (c) needs a DB failure in the narrow window after the last Twilio call, so it is rare.
- Paths (a) and (b) mainly leave orphaned TrustHub profiles under the company's own subaccount. Corrections still reach Twilio, through a fresh profile. The cost Ruling AL warns about ("corrections never reach Twilio") does not occur.
- Duplicate billed brands need the brand POST itself to time out, or path (c).
It is still worth fixing before T37's real smoke test. Each orphan is a separate profile for the same EIN that Twilio reviews, and a 5-attempt retry turns one outage into several of them.
The finding's own fix is muddled in two places:
- It proposes an onProgress callback but also says not to write through it. The simpler version is a callback that only collects the sids into a local object.
- Moving recordUsage outside the lock with nothing else added would lose the fee: after commit, brandStageDue is false, so a retry never records it. recordUsage is idempotent on (company, kind, ref_type, ref_id) (usage.ts:49-52), so it can safely run after commit on every pass.

**VERIFIED FIX:** 1. Collect partial sids instead of returning them only at the end.
   - providers/registrar.ts: add an optional `onProgress?: (p: Partial<{ customerProfileSid: string; trustProductSid: string; brandSid: string }>) => void` to the submitBrand input.
   - brands.ts: pass onProgress through to submitBrandFlow.
   - brand-profile.ts submitBrandFlow: call `onProgress({ customerProfileSid })` right after `createCustomerProfile` returns. Better, call it inside createCustomerProfile right after the CustomerProfiles POST at line 99, before any EndUser call. Then call `onProgress({ trustProductSid })` right after the TrustProducts POST at line 180, and `onProgress({ brandSid })` after the BrandRegistrations create at line 211.
   - FakeTextingRegistrar: support onProgress the same way, plus a failNext variant that fails after a given step.
2. advance.ts:
   - Declare `const partial = {}` before calling submitBrand, and pass `onProgress: (p) => Object.assign(partial, p)`.
   - Catch every error. In the catch, first run `await updateRegistration(tx, companyId, { ...partial })`, writing only the keys that are present. If brandSid is present, also write brandStatus 'pending'.
   - For a RegistrarRejectedError, write the rejection fields in the same update, as now, and return 'rejected'.
   - For any other error, return `{ retry: err }` from the lock callback. After withRegistrationLock returns, check `if (typeof outcome === 'object') throw outcome.retry;`. The sids then commit and the job still retries.
   - A retry or resubmission now sees previous.customerProfileSid and trustProductSid and takes the update-in-place and reuse paths.
   - Edge case: a profile whose create succeeded but whose assignments were never made would make updateCustomerProfile throw 'record is incomplete'. Make updateCustomerProfile create and assign any missing business, representative or address entity instead of throwing.
3. Fee:
   - Remove recordUsage from inside the lock.
   - After the lock commits, whenever the registration has a non-null brand_sid (the 'submitted' or 'idle' outcomes), call recordUsage with refId = brand_sid. It is idempotent through onConflictDoNothing, so the fee is recorded even if an earlier attempt failed after commit.
   - Then call continueRegistration.
4. Tests (DB-backed advance tests; the fake registrar fails after a step):
   (a) Fail after the CustomerProfiles step with RegistrarUnavailableError. Expect the job to throw and the row to have customer_profile_sid set. On the next run, expect submitBrand to receive previous.customerProfileSid equal to that sid, and no second profile create.
   (b) Return a noncompliant evaluation after the profile is created. Expect the row to have campaign_status 'rejected' with customer_profile_sid saved. After resubmitting, expect the update-in-place path.
   (c) Fail recordUsage once. Expect brand_sid to stay saved and the retry not to call submitBrand again, with exactly one texting_registration_fee row for that brand sid.


## R12 (jobs-reliability/J1; verdict amended, minor; tasks T27, T9, config (T18/T19))

**Where:** apps/api/src/account/texting/advance.ts

**Problem:** Stage 1 calls the Twilio submitBrand flow (creates a customer profile, trust product and brand, which are paid and not idempotent) inside the registration-lock transaction. It then saves the new sids with updateRegistration (line 70) and records the brand fee with recordUsage(...billingConfig(deps)...) (lines 88-100) in that same transaction. If anything after submitBrand throws, the transaction rolls back and the sids are lost. The likeliest cause is billingConfig(deps) throwing 'BILLING_PLANS_FILE is not set': config.ts leaves BILLING_PLANS_FILE unset in production when STRIPE_SECRET_KEY is unset, and createRegistrar is configured as soon as the Twilio master credentials are set. Any DB error in recordUsage does the same.

**Failure scenario:** Production with TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PRIMARY_PROFILE_SID set, and Stripe and BILLING_PLANS_FILE unset (or a plans file that fails to read or parse). An owner submits the texting registration. Attempt 1 submits the brand to Twilio, then billingConfig throws and the transaction rolls back, so brand_sid and customer_profile_sid are NULL. The job retries with backoff for 5 attempts. Each retry sees previous.customerProfileSid, trustProductSid and brandSid all null, so it creates a new Twilio profile, trust product and brand each time. That is 5 orphan, billable brand registrations, and the company stays 'pending' with no brand sid. The same duplication happens on any transient DB failure in recordUsage.

**Verifier:** The structure the finding describes is real. In apps/api/src/account/texting/advance.ts:46-101, the paid, non-idempotent submitBrand call (line 59) runs inside the withRegistrationLock transaction (packages/db/src/system/texting.ts:125-145). Its sids are written with updateRegistration on the lock tx (line 70). After that, billingConfig(deps) and recordUsage run (lines 88-99, on a separate withTenant connection). Any throw after submitBrand rolls back the sids. The job then retries up to 5 times (jobs/queue.ts:11, retryLimit 4), and each retry sees previous.* as null, so it creates a new profile, trust product and brand.

The finding's "likeliest cause" does not hold, though. A registration can only be submitted when the company has a Stripe subscription: texting-routes.ts:49 checks hasPaymentMethod(stripeSubscriptionId...). A subscription only exists when Stripe is configured, and config.ts:174 makes BILLING_PLANS_FILE required in production whenever STRIPE_SECRET_KEY is set. The company also subscribed through billing-routes.ts:34/67, which already called billingConfig successfully. So "Twilio set, Stripe and plans file unset" cannot reach stage 1. That leaves two causes: a transient DB error in the separate recordUsage transaction, or the plans file becoming unreadable in the worker process. Both are possible but unlikely, so this is a robustness gap with a real money cost when it happens. That makes it minor, not an integration-breaking Important problem.

The proposed fix also needs a correction. If recordUsage simply moves after withRegistrationLock and then fails, the retry sees brandSid set, brandStageDue (line 30) returns false, and the run returns 'idle' at line 48. The fee is then never recorded, because nothing redoes it.

**VERIFIED FIX:** In apps/api/src/account/texting/advance.ts:
(1) Read `const feeCents = billingConfig(deps).pass_through_cents.brand_registration;` at the top of the lock callback, before ensureSubaccount and submitBrand, so a config error fails before anything is created at Twilio.
(2) Make the updateRegistration with the new sids (line 70) the last thing the lock transaction does: return 'submitted' together with brandSid, and remove the withTenant/recordUsage block from inside the callback.
(3) After withRegistrationLock returns, and on every run, not only 'submitted', reload the registration (loadRegistration on pools.system). If brandSid is non-null, call recordUsage with refType 'texting_brand' and refId brandSid. This is idempotent through the unique ref, so it is a no-op when the fee row already exists. A run that failed only at the fee step then records the fee on retry, even though brandStageDue is false and stage 1 returns 'idle'.
Test in the advance/registration API tests, using FakeTextingRegistrar: make recordUsage (or the tenant pool) throw once after submitBrand succeeds, then run advanceRegistration twice. Assert that submitBrand was called exactly once, that brand_sid is persisted after the first run, and that exactly one texting_registration_fee usage row exists for that brand sid after the second run.


## R13 (texting-registration/TX-2; verdict amended, important; tasks T25, T28)

**Where:** apps/api/src/providers/twilio/accounts.ts:73-110

**Problem:** ensureNumber checks only the numbers attached to the messaging service (line 81). If the purchase succeeds but the attach to the service fails, or the caller fails after the call, the number exists in the subaccount but is not attached. The next call sees an empty service list and buys a second number.

**Failure scenario:** POST IncomingPhoneNumbers.json succeeds (line 95), then the POST to Services/{mg}/PhoneNumbers returns a 5xx or times out. mapSetupErrors raises RegistrarUnavailableError and the job or poll retries. The retry finds the service list empty, searches again and purchases another number, so the company is billed monthly for each orphan. The same double purchase happens if addMainNumber or the later DB write fails after ensureNumber returns, but only when the attach had also not completed.

**Verifier:** The finding is real, but the severity is too high. In apps/api/src/providers/twilio/accounts.ts, lines 81-91 only check whether a number is already reusable by asking for the numbers attached to the messaging service (GET Services/{mg}/PhoneNumbers). The purchase (POST IncomingPhoneNumbers.json, lines 95-99) and the attach (POST Services/{mg}/PhoneNumbers, lines 100-102) are two separate calls with nothing protecting the gap between them. If the attach returns a 5xx or times out, TwilioApiError or TwilioUnreachableError becomes RegistrarUnavailableError (lines 173-183). On the next call the service list is empty, so it searches and buys a second number. Every orphaned number in the subaccount costs a monthly fee. The code follows task-25-brief.md lines 31-34 exactly, so the gap comes from the brief and is not a builder deviation. No ruling or deferred minor in progress.md covers it. I am lowering it from critical to important because nothing in the merged F3 code at 330ca23 calls ensureNumber. The only callers are tests and the fake. provision-texting.ts and account/texting/advance.ts only call ensureSubaccount. T28, the job that buys numbers, is excluded from this merge. So the bug cannot happen today. It becomes reachable once T28 lands, and then it needs a partial Twilio failure. The cost is a repeated charge for each orphaned number, not lost data or a tenant breach. The proposed fix is right in substance. It needs the exact response shape and the already-attached handling spelled out, and the brief needs updating too, or T28 or a later brief will be written against the old algorithm.

**VERIFIED FIX:** In apps/api/src/providers/twilio/accounts.ts, ensureNumber:
(1) Keep the existing check of the service's numbers first. If a number is attached, return it. This keeps the 'reuses a number already on the service' test passing.
(2) Otherwise, as the subaccount, call GET ${TWILIO_API}/Accounts/${sub.accountSid}/IncomingPhoneNumbers.json with { PageSize: '20' }. The response shape is { incoming_phone_numbers: Array<{ sid, phone_number, capabilities }> }, where capabilities is an object of booleans that normalizeCapabilities already handles. If a number is listed, take the first one as `owned` and skip the search and purchase.
(3) Otherwise run findAvailableNumber and POST IncomingPhoneNumbers.json as now, and set `owned` to the purchased number.
(4) Attach with POST Services/{mg}/PhoneNumbers { PhoneNumberSid: owned.sid }, wrapped in a try/catch. If the error is a TwilioApiError with code 21710 (the number is already in this Messaging Service), treat it as success. Rethrow anything else, so mapSetupErrors still turns it into RegistrarUnavailableError.
(5) Return { e164: owned.phone_number, phoneNumberSid: owned.sid, capabilities: normalizeCapabilities(owned.capabilities) }.
Add an `incoming-numbers-empty` fixture and an `incoming-numbers-one` fixture under apps/api/test/fixtures/twilio. Route 'GET .../IncomingPhoneNumbers.json' to the empty one in the existing purchase tests.
Add a test to apps/api/test/twilio-accounts.test.ts called 'an attach that failed is retried without a second purchase'. In the first call, the service-number POST answers 500 and the call rejects with RegistrarUnavailableError. On the second call, the service list is empty and IncomingPhoneNumbers returns incoming-numbers-one. Assert across both calls that there is exactly one POST to IncomingPhoneNumbers.json, no AvailablePhoneNumbers request on the second call, and that the second attach POST carries the owned PhoneNumberSid.
Also update step 1 of ensureNumber in /home/user/roofline/ops/sdd/f3/task-25-brief.md so that T28, when it is built, relies on this behaviour. Add a ledger note in progress.md.


## R14 (texting-registration/TX-3; verdict amended, minor; tasks T26, T27)

**Where:** apps/api/src/providers/twilio/brands.ts:139

**Problem:** mapErrors turns every Twilio 4xx (TwilioApiError) into RegistrarRejectedError. That includes 401/403 for bad credentials, 404, 409, and 429 rate limits. advanceRegistration treats a RegistrarRejectedError as a customer-fixable rejection: it sets campaign_status 'rejected' with the generic carrier-turned-this-down reason and does not retry.

**Failure scenario:** Twilio answers 429 (or 401/403 because of a bad master token or a missing TrustHub permission) during submitBrand. advance.ts:67 stores 'The phone carriers turned this down. Check your details and send it again.' with no fields, and the job ends. The owner sees Fix and resubmit with nothing highlighted for a problem that is not theirs. This breaks the spec rule that provider failures retry with backoff for 5 attempts through pg-boss. Nothing retries it automatically, because the registration is no longer 'pending'.

**Verifier:** The code path is as described. http.ts:75-78 turns every 4xx into TwilioApiError, and 5xx and network errors already become TwilioUnreachableError. Then brands.ts:139 turns every TwilioApiError into RegistrarRejectedError. advance.ts:77-84 records campaign_status 'rejected' with the fallback reason and does not rethrow, so pg-boss never retries (queue.ts:11, retryLimit 4).

The behaviour is what the task-26 brief asks for, though. Its line 37 says: "a TwilioApiError on any POST of steps 1-9 or the campaign POST → RegistrarRejectedError whose reasonText is `Twilio error ${code}`". So this is a gap in the brief, not a mistake by the T26 implementer. The finding also overstates two points:
- 5xx responses already retry.
- 401 is unlikely, because the calls use credentials of a subaccount that ensureSubaccount has just created or stored.

The case that remains is real. A 429 (rate limit, code 20429), or a 403 permission refusal on TrustHub, is not something the customer can fix. It goes against the global constraint "provider failures retried with exponential backoff, up to 5 attempts", and it shows the owner "the carriers turned this down". The impact is small. Recovery is one click: the owner resubmits unchanged, brandStageDue runs again and the call succeeds. No fee is recorded on a rejection, and no data or tenant rule breaks. That is why I set it to minor, not important.

The proposed fix goes too far. Mapping 404 and 409 to unavailable departs from the brief without a ruling. A 404 on a stale previous sid would then retry 5 times and fail the same way each time.

**VERIFIED FIX:** In apps/api/src/providers/twilio/brands.ts mapErrors (line 139), before the RegistrarRejectedError line, add:

`if (error instanceof TwilioApiError && (error.status === 429 || error.status === 401 || error.status === 403)) throw new RegistrarUnavailableError(`Twilio refused a request (code ${error.code ?? 'none'}).`);`

This keeps the numeric code only, the same pattern as accounts.ts:180. Leave every other 4xx (400, 404, 409, 422) as RegistrarRejectedError, which is what task-26-brief line 37 asks for. advance.ts needs no change, because it already rethrows non-rejection errors so pg-boss retries them.

Add these tests to the T26 brands test file:
- Give the fixture fetch a 429 response with body {code:20429} on the brand POST. Expect submitBrand to reject with RegistrarUnavailableError, and expect the message to contain no Twilio text.
- Do the same with a 403 response.

Add a test to the T27 registration test: call t.registrar.failNext('submitBrand','unavailable'), then GET. Expect the state to still be pending or waiting, not needs_fix. The fake already models the unavailable case.

Record this in progress.md as a ruling that amends task-26 brief line 37, so that T28's campaign POST and status reads use the same split.

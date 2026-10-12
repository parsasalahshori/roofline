# F3 review fixes, group C (texting provider): R11-R15

Branch f3-review-c, commits 1c6dad0 + 9aa2df3. CI run 38197251684 PASSED (first run 38195897804 failed: texting-recorded.test.ts lacked the new GET IncomingPhoneNumbers route; fixed in 9aa2df3).

## Built
- P1 providers: registrar.ts onProgress; brands.ts forwards onProgress, mapErrors 401/403/429 -> RegistrarUnavailableError (R14); brand-profile.ts onProgress after profile, trust product, new brand; updateCustomerProfile creates missing entities instead of throwing; accounts.ts ensureNumber reuses attached, then owned unattached numbers, treats 21710 on attach as attached (R13); fixtures incoming-numbers-empty/one, assignments-empty, trust-assignments-both; task-25 brief step 1.
- P2 advance/progress/fake: advance.ts persists partial sids on failure (R11), brand fee after commit idempotent by brand sid (R12); progress.ts number fee after the number is saved, refId providerSid:month (R15); FakeTextingRegistrar onProgress + failAfter(step, what).
- P3 tests: texting-submit, texting-progress, fakes, twilio-brands, twilio-accounts, texting-recorded (owned-numbers route).

## Rounds
- R11 fixed. R12 fixed. R13 fixed. R15 fixed.
- R14 AMENDED: task-26 brief line 37 now reads 401/403/429 = RegistrarUnavailableError (retried, "Twilio refused a request (code N)."), other 4xx stay rejections. Controller to add as a ruling.
- Review 1: 2 findings, amended; contact check RC-1, RC-2 amend. Review 2: 0 findings.

## Minors
- feeCents is read before the lock, so a config error also fails an idle pass.
- Number fee check runs on every pass when a saved main number exists (later month records that month's fee).
- No dedicated test for updateCustomerProfile creating missing entities.

## Verify
typecheck and lint clean locally; CI run 38197251684 passed (Platform, E2E, v1).

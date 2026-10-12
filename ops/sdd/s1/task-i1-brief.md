### Task I1: Wave 1/2 integration fixes (from the contact-201 group check)

**Base:** `s1-storm` after T1, T2, T4, T5, T6 and the e1-estimator/c1-crm merges. Pure shared and send-gate code.

**Files:** Modify `packages/send-gate/src/email.ts`, `packages/shared/src/steps.ts`, `packages/shared/src/storm-templates.ts` (doc comment only); Test `packages/send-gate/test/email.test.ts`, `packages/shared/test/steps-storm.test.ts`.

**Fixes (all four):**
1. **Unfilled tokens and the postal address (important).** In `decideEmail`, for `purpose: 'marketing'`:
   - the body must contain `companyAddress.trim()` (not just a non-blank `companyAddress`). If it doesn't, return rule `content` with the existing message `'Emails need the company name, mailing address and unsubscribe link.'`;
   - if the subject or body still holds an unfilled token matching `/\{(first_name|company|hail_size|street|day|company_address)\}/`, return rule `content` with the new message `'This message still has a blank to fill in.'` (a module constant). `{unsubscribe}` stays allowed, because the send pipeline swaps it for the link.
   - Keep the rule order in spec §5.2: billing, contact, content, dedupe, frequency, quiet hours.
   - Fix the doc comment on `renderStormTemplate` in `storm-templates.ts`: unknown or missing tokens are left as-is, and `decideEmail`'s content rule blocks emails that still hold them. Texts are checked by Task 11/12's render hook, which must refuse a rendered body that still holds a storm token. Leave all other code in that file unchanged.
   - Tests: a marketing email whose body lacks the address → `content`; a body or subject with a leftover `{street}` → `content` with the new message; `{unsubscribe}` left in → ok.
2. **build_routes preview vs Task 5 (important).** In `steps.ts`, import `MAX_DOORS_PER_ROUTE` and `MAX_DOORS_PER_PLAN` from `./door-routes.ts`. Use `routes = Math.max(reps, Math.ceil(maxDoors / MAX_DOORS_PER_ROUTE))` in the title (`'{routes} door-knock routes · {doors} doors'`) and in `minutesSaved` (120 × routes). The per-rep lines show each rep's share of routes and doors, using the same round-robin rule as `splitIntoRoutes`: routes go to reps in turn, and doors are approximately `ceil(maxDoors / routes)` per route. Use `.max(MAX_DOORS_PER_PLAN, ...)` for `maxDoors`. Tests: 1 rep and 400 doors → title `'3 door-knock routes · 400 doors'`, minutesSaved 360.
3. **Ad daily amount (minor).** The `create_ad_campaign` preview uses `dailyBudgetCents(p.maxSpendCents, p.days)` from `./storm.ts`, not `Math.round`. Test: 2000 over 3 days shows `$6.66 a day for 3 days`.
4. **Email preview sample (minor).** The `send_email_batch` `messageSample` renders with `renderStormTemplate` from `./storm.ts`, filling sample values for the storm tokens (`first_name` from facts or `'Sam'`, `company` from facts, `hail_size` `'1.75"'`, `street` `'Maple St'`, `day` `'yesterday'`, `company_address` from facts if present, `unsubscribe` `'(unsubscribe link)'`). The owner then never sees raw `{street}` tokens. Keep `customerIds` lower-cased; `fields` map keys are also lower-cased uuids (`z.uuid().transform(lower)` on the record key, or a refine that rejects upper-case keys). Tests to match.

**Watch for import cycles:** `storm.ts` re-exports `storm-templates.ts` and `storm-math.ts`; `steps.ts` already imports `AD_PLATFORMS` from `storm.ts`. If a cycle appears (check that `storm-templates.ts` doesn't import `steps.ts`), import from the leaf files directly.

**Verify:** `npx vitest run --project @roofline/shared --project @roofline/send-gate`, typecheck, lint; ci-check (Platform).
**Commit:** `fix(shared,send-gate): storm email gate checks address and blanks; route and ad previews match the planners`

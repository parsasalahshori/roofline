### Task R9 (Ruling BF, security review finding 2 High + 14/18 Low): public forms work in real browsers; public routes limited; tokens out of logs

**Base:** `s1-storm` 83e9856. Source: `ops/sdd/integration/security-review.md` on `origin/sec-review` (findings 2, 14, 18). API and e2e.

**Fixes:**
1. **(High) The unsubscribe confirm page sends a real Origin.**
   - `apps/api/src/public/unsubscribe.ts` sets `Referrer-Policy: no-referrer` (line ~151), and helmet's default is the same. Serve the confirm page with `Referrer-Policy: same-origin`, as the storm page already does (`public/storm-page.ts:56`).
   - Do NOT loosen `blockCrossSiteMutations` or `stormRequestOriginGuard` to accept `null`.
   - API tests:
     - The GET confirm page and `GET /storm/:code` answer `Referrer-Policy: same-origin`.
     - A POST with `Origin: null` is refused on both routes. This documents the dependency.
     - The no-Origin one-click unsubscribe POST still works.
2. **(High) Add e2e specs that submit both forms in a real browser** (`apps/web/e2e/`, follow the existing storm specs and seed helpers):
   - Open the storm landing page on its company host as the real page, fill in the form, submit with a real click, and land on the thank-you page. Check the request recorded through the UI or API.
   - Open the unsubscribe link (build the token through the existing test helper or seed route) and click Unsubscribe. The confirmation shows; a second visit shows that it is already done.
   - Do not stub the network for these submits.
3. **(Low 14) Tokens stay out of logs.** Make `pathForLog` in `apps/api/src/errors.ts` also scrub `/u/<token>` to `/u/:token`, and any S1 public token path such as the storm page code if it holds a secret. Add a unit test.
4. **(Low 18) Rate-limit the unlimited S1 public routes** using the existing limiter helpers in `rate-limit.ts`, with per-IP limits generous enough for real use:
   - `GET /storm/:code`;
   - the policy pages;
   - `GET` and `POST /u/:token`;
   - `/hooks/postmark` if S1 mounted it.
   Leave `/hooks/twilio*` to F3. Add a test that the limit answers 429.

**Do not touch:** ad accounts or 0018 (R8); storm-requests consent or budget (R10), though the e2e may submit the form.
**Verify:** typecheck, lint, `npx playwright test --list -c apps/web/playwright.config.ts`. ci-check `CI_JOBS="Platform E2E Hail"` (E2E must actually run the new specs green).
**Commit:** `fix(storm): public forms send a real Origin, public routes limited, unsubscribe tokens kept out of logs (Ruling BF)`

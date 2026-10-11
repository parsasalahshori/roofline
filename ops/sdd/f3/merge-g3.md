minor [14,15]: Together, T14's strict acceptance rule and T15's sign-up flow can block some real addresses. T14 returns null for any result with accuracy under 0.8 or with an accuracy_type outside the six it accepts (for example 'place' or 'county'), and for a Geocodio 422. T15's locateAddress turns null into not_found, and sign-up then refuses with a 400 on companyAddress and creates nothing. With a real key, a
 -> No change is needed to merge. Flag it to the controller or architect as a product question: should a low-confidence result at sign-up be treated as 'unavailable', so the account is created unlocated and fixed later through Setup and /locate? Or is the hard refusal intended? If it is changed later, the change belongs in T15's createCompanyAccount, not in T14's geocoder.

minor [14,15]: Sign-up now waits on a network call before anything is written. T15 calls locateAddress, which calls GeocodioGeocoder.geocode with T14's default 8000 ms timeout. When Geocodio hangs, POST /api/auth/signup and new-user POST /api/auth/google take about 8 seconds before falling back to the unlocated account. This is correct behaviour; it is noted so that nobody 'fixes' a slow sign-up test or e2e late
 -> Optional: give the sign-up path a shorter timeout in a later task, for example a GeocodioGeocoder with a lower timeoutMs for interactive calls. Keep 8 s for batch imports. No action is needed for this merge.

minor [15]: The not-found message "We couldn't find that address. Check the street, city and state." is defined twice, as ADDRESS_NOT_FOUND_MESSAGE in apps/api/src/auth/routes.ts and as NOT_FOUND_MESSAGE in apps/api/src/routes/company.ts. The brief's interface also lists `export type Located = { result: GeocodeResult }` in company/location.ts, which T15 did not export. Nothing consumes it today.
 -> Optional follow-up: export one constant (for example from apps/api/src/company/location.ts) and import it in both routes. Add the Located type only if a later task (T16 or T24) imports it.

minor [15,17]: Two near-duplicate helpers format an address as 'street, city, ST zip'. T15's companyLocationFacts builds it from the raw SQL row in packages/db/src/repos/company-location.ts; T17's addressLine builds it from PolicyCompany in apps/api/src/public/policy-text.ts. They live in different layers and serve different purposes (one is geocoder input, the other is HTML display), and both are acceptable. Wh
 -> Leave both as they are. If a third copy appears, move a formatAddressLine helper into @roofline/shared.

All three branches can merge with no conflicts.

**Shared files and bases**
- None of the three branches changes a file that another one changes:
  - T14: apps/api/src/providers/geocodio.ts plus fixtures and geocodio.test.ts.
  - T15: auth/middleware.ts, auth/routes.ts, company/location.ts (new), routes/company.ts, test/helpers.ts, the auth-* tests, signup-company and company-location tests, and packages/db/src/repos/company-location.ts.
  - T17: public/policies.ts, public/policy-text.ts (new), public/policy-urls.ts, policy-pages.test.ts and packages/db/src/system/policy.ts.
- The three bases (178b182, bd068f7, 5dc4867) are separate merge commits of the same tree (b70976f plus T9 under review), and `git diff` between them is empty.
- `git merge-tree --write-tree f3-setup <branch>` against the current f3-setup (7b988eb, which already has final T9, T13 and T23) is clean for all three branches. Between the T14 base (178b182) and f3-setup, the only differences in any of the three branches' areas are in apps/api/src/providers/twilio/{http,sms}.ts (from T13).
- Suggested order: T14, then T15, then T17. Any order works.

**How the interfaces fit together** (checked against the plan's Task 14, 15 and 17 sections)
- T15 calls `locateAddress(deps.geocoder, ...)`, which relies on three things from the existing geocoder interface (providers/geocoder.ts from T9, which none of these branches change):
  - `Geocoder.configured`: T14's GeocodioGeocoder sets `configured = true`, and UnconfiguredGeocoder is false.
  - `geocode()` returns `GeocodeResult | null`.
  - `GeocoderUnavailableError`.
- T14 produces exactly the GeocodeResult fields that T15 consumes: street (number plus formatted_street, the same shape as FakeGeocoder's '1200 Farnam St'), city, state, zip, timezone (from fields.timezone.name; T15 checks it with isTimeZone), lng and lat.
- T14's `geocodioFor` now returns a GeocodioGeocoder when GEOCODIO_API_KEY is set. createGeocoder still prefers FakeGeocoder under FAKE_PROVIDERS, so T15's tests keep using the fake.
- T17's companyForPolicyPage reads companies.phone_e164, address_street/city/state/zip, legal_name, email, website and slug. T15's sign-up and /locate write phone and address into the same columns, so the policy pages show what sign-up stored. All values are HTML-escaped.
- policyUrls has a narrower `Pick<Config, ...>` parameter, which is backward compatible. Nothing outside tests calls it yet.
- `@roofline/db/system` already re-exports './policy.ts', and `@roofline/db` already re-exports './repos/company-location.ts', so no index edits are needed.

**Tests**
- Only T15 changes test/helpers.ts (it adds SIGNUP_COMPANY). Neither T14 nor T17 signs up through the API: T17 uses the seeded acme-roofing, and T14's test is a pure unit test with an injected fetch. On f3-setup, only the auth-* tests (which T15 updates) and T15's new signup-company test call /api/auth/signup.
- apps/web has no sign-up caller yet (that is T31), so nothing in the web app breaks.

**Copy and lint**
- All changes are API-side, with no JSX and no raw buttons.
- User-facing strings live in route constants, as the briefs say. T17's HTML is server-rendered template text.
- ESM imports use explicit .ts extensions throughout.

**Checks after merging**
- Run `/home/user/roofline/ops/bin/slot npm run typecheck` and `/home/user/roofline/ops/bin/slot npm run lint`.
- `apps/api/test/geocodio.test.ts` runs locally without a database.
- Leave the database-backed files (signup-company, company-location, auth-config, the auth-* tests and policy-pages) to GitHub Actions through ci-check. Do not run them locally.
- If only apps/api/test/rep-visibility.test.ts:400 fails, it is the known flake; re-run that file alone.

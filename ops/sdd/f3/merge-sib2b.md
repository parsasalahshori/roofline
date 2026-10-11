# Merge notes, sibling 2b (F3 Task 7; Opus contact 35, run wf_8adb9634-824)

- Branch f3-t7, head 76aa441, base f3-setup 0351174. CI run 38181073895: Platform job success (includes the @roofline/api import-plan test on PostGIS).
- Review: round 1 clean, no fixes; nothing parked. parse.ts untouched, so T6's hard-coded '20,000' message is still open for whoever next touches parse.ts.

## Group check merge notes

I reviewed one task, T7 (f3-t7 @ 76aa441, base 0351174). It is one commit touching 6 files. New: apps/api/src/imports/normalize.ts, apps/api/src/imports/plan.ts, apps/api/test/fixtures/import-1000.ts, apps/api/test/import-plan.test.ts and packages/shared/test/consent.test.ts. Changed: packages/shared/src/consent.ts, where the `export {};` stub now holds the real code; packages/shared/src/index.ts already had `export * from './consent.ts'`.

Interfaces: every signature matches the brief exactly (consentAttestationText, ExistingConsent, importConsent, NormalizedRow, RowSkip, normalizeRow/State/Zip/Stage, ExistingCustomer, ExistingIndex, PlannedRow, ImportPlan, planImport, previewRows). They use the existing shared types without redefining them: ImportMapping, ImportField, SkipKey, ImportCounts and ImportPreviewRow from imports.ts, toE164 from phone.ts and toUsStateCode from address.ts. No helper is duplicated; state normalizing reuses toUsStateCode. The fixture matches the brief row by row, and the expected counts check out by hand: attested gives 850 + 10 + 10 = 870, unchecked gives express 860 and unchanged 20, and optedOutKept is 20. There is no JSX or UI copy here; the skip-reason strings live in the API, as the brief specifies.

Conflicts: none. No other F3 branch (t3, t4, t5, t8, t10, t11, t12) touches these paths. `git merge-tree origin/f3-setup f3-t7` is clean, even though f3-setup has moved past the base (F2 merge, T3–T6 and T10). Merge with a plain `git merge f3-t7` into f3-setup; no manual resolution is needed.

Tests: packages/shared/test/consent.test.ts passes locally (13 tests). I did not run apps/api/test/import-plan.test.ts locally because of the house rule against @roofline/api vitest; it uses no database (only parse, mapping, normalize and plan), so leave it to CI through ci-check.

Carry forward to T23/T24: move ExistingIndex, ExistingCustomer, NormalizedRow and RowSkip into @roofline/shared so packages/db can use them (see the important issue).

## Group check issues

- **T7** (important): ExistingCustomer, ExistingIndex and NormalizedRow are defined in apps/api/src/imports/plan.ts and normalize.ts, as the brief says. But later tasks need them inside packages/db: T23's existingIndexFor in packages/db/src/repos/imports.ts returns ExistingIndex, and T24's ChunkWrite in packages/db/src/repos/import-apply.ts uses NormalizedRow and ExistingCustomer. packages/db depends only on @roofline/shared, so it cannot import from apps/api. This does not block the T7 merge, but T23 and T24 will hit it. Suggestion: Merge T7 as it is. When T23 and T24 are dispatched, tell them to move these three types (plus RowSkip) into packages/shared/src/imports.ts, keeping the same shapes, and have normalize.ts and plan.ts re-export them from @roofline/shared. That is a type-only move. Do not let T23 or T24 redefine the types separately in db.
- **T7** (minor): normalizeRow returns badPhone before it checks for an email. A row with a bad phone and a valid email is skipped, even though it has a usable contact. This follows the brief's skip order literally, and the fixture has no such row, but real customers who could be reached by email are dropped. Suggestion: Leave as is unless the spec owner wants email-only rows kept. If they do, return badPhone only when there is also no valid email.
- **T7** (minor): previewRows always builds the address as `${addressLine}, ${city}, ${state} ${zip}`. An address is kept with a street plus a ZIP only, so blank parts show up as text like '12 Elm St, ,  02134'. Suggestion: Join only the non-empty parts, either now or when T23/T34 consume the preview.
- **T7** (minor): normalizeZip takes the first five-digit run it finds, so a malformed six-digit value like '123456' becomes '12345' instead of null. Suggestion: Optionally anchor the match to /^\d{5}(?:-?\d{4})?$/ after trimming, or accept a five-digit run only when it is not followed by a digit.
- **T7** (minor): importConsent ignores hasPhone for existing customers. An email-only row that matches an existing 'none' customer raises them to attested or express even though the row has no phone. The brief allows this, but T24 should not record attestation evidence for a customer with no phone on file. Suggestion: No change in T7. In T24, check that the matched customer has a phone before writing the consent record.

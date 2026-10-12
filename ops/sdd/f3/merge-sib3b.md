# Merge notes: sibling 3, group G4 (F3 Tasks 13, 23, 24)

Session session_01RypesnL2fbawyJH5HtdS7E (Ruling S). Only the Platform CI job is judged.

| Branch | Base | Head | Workflow | Review | CI (Platform) |
|---|---|---|---|---|---|
| `f3-t13` | f3-setup 9a469c8 + f3-t9 80083cc; then final f3-setup 74ee852 merged in | dc76a48 | wf_914b4dad-c00 (contact 45) | round 1 clean | 38184832879: success |
| `f3-t23` | same | 5e3e308 | wf_914b4dad-c00 (contact 45) | round 1 clean | 38184832984: success |
| `f3-t24` | f3-t23 5e3e308 | b415492 | wf_67c1a16b-737 (contact 47) | round 1 clean; group check found 1 important issue, fixed in b415492 | see the controller message |

T13 and T23 are already merged into f3-setup (7b988eb). T24 merges cleanly onto the current f3-setup: `git merge-tree` on dd689aa reports no conflicts.

## T13: Twilio sending

- Files:
  - `providers/twilio/{http,sms}.ts` and `messaging/{gate-request,outbound,send-batch,dispatcher}.ts`
  - `repos/messages.ts` (only `textingCompanyFacts`) and `repos/opt-outs.ts`
  - tests `twilio-sms` and `send-batch`, plus the `pgboss` expectation, which matches f3-setup.
- T12's lease line stays the first statement of the send-batch loop. T11's `markTextSent` lock order is unchanged.
- Minors:
  - `sms.ts` has a private `segmentsOf`, because `countSegments` is not exported from send-gate.
  - No test covers a 4xx with an unreadable body, or the codes 21211/21612.
  - There is no direct unit test of `recordCarrierOptOut`.

## T23: Import API

- Ruling AC is done: `ExistingCustomer`, `ExistingIndex`, `NormalizedRow` and `RowSkip` now live in `packages/shared/src/imports.ts`, and `normalize.ts`/`plan.ts` re-export them.
- Ruling AM: `existingIndexFor` marks a customer optedOut when ANY of their phones is in `opt_outs`.

## T24: Import job

- Files:
  - `apps/api/src/imports/run.ts` (the T9 stub)
  - `packages/db/src/repos/import-apply.ts` (the T1 placeholder)
  - `apps/api/test/import-run.test.ts` (new)
  - `apps/api/test/jobs.test.ts`: the default-handler test no longer sends `import-customers`, which now runs the real job.
- Carries kept:
  - `queue.ts` is imported for its types only.
  - `importId` is checked against a uuid pattern before any DB access, and gives a plain error if it doesn't match.
  - Rows are written in bulk, with no `createCustomer`.
  - A matched customer whose row has no phone keeps their consent status, with no attestation evidence.
  - The moved types are imported only from `@roofline/shared`.
- Fix after the group check (b415492): `processed` now adds only the rows `applyImportChunk` actually wrote. Before, it added `chunk.length`, so under SKIP LOCKED it over-counted and the loop spun. A chunk that wrote nothing means another runner holds those rows, so this run returns without finishing; that runner finishes the import.
- Deviations from the brief:
  - `ChunkWrite.geo` is declared inline, not as `GeocodeResult`, because packages/db cannot import an apps/api type.
  - `ChunkWrite` gained `createdByUserId`.
  - `match`, `consent` and `consentChanged` are placeholders; `applyImportChunk` re-derives all three from the database.
  - Resume detection is `hasPlannedSkips` OR any row with an outcome, because a file with zero skips would otherwise re-plan on every resume.
- Minors:
  - Geocoding covers every row with an address, including homes that already exist, which spends extra quota.
  - A failed re-geocode counts as notLocated.
  - `writePlannedSkips` leaves `updated_at` unchanged.
  - An archived matched customer is treated as new; check that `existingIndexFor` agrees.
- Expected conflict: whichever later task makes `advanceRegistration` real will edit the same `jobs.test.ts` block (~lines 1006-1013). Keep T24's removal of the `import-customers` send, and keep whatever texting-registration change that task needs.

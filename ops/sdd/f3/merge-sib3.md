# Merge notes: sibling 3 (F3 Tasks 6, 10, 11)

Sibling session session_01RypesnL2fbawyJH5HtdS7E, Ruling S. All three branch from `f3-setup` d629c74 (Tasks 1, 2, 8).
CI: only the Platform job is judged. The v1 job fails on every one of these branches because the old v1 data file is empty (fixed on `f2-shell` in 0b81e1b), not because of these tasks.

| Branch | Base | Head | Workflow | Review | CI (Platform) |
|---|---|---|---|---|---|
| `f3-t6` | d629c74 | 1ca87f9 | wf_f8f09095-c88 (contact 41) | round 1 clean | run 38179529475: success |
| `f3-t10` | d629c74 | d1e0d9b | wf_f8f09095-c88 (contact 41) | round 1 clean | run 38179515041: success |
| `f3-t11` | d1e0d9b (f3-t10) | d33ecba (e689d8c + lock-order hardening) | wf_2d479fae-7ac (contact 44) | round 1 clean | e689d8c: run 38181151654, success |

## Merge order

1. `f3-t6` and `f3-t10` in either order. Their files don't overlap, so neither merge conflicts.
2. Then `f3-t11`, which is stacked on `f3-t10` and includes it. Merging `f3-t11` alone brings in T10 as well.

## T6: reading import files

- **Files:**
  - new: `apps/api/src/imports/{parse,mapping}.ts` and `apps/api/test/import-{parse,mapping}.test.ts`
  - appended to: `packages/shared/src/imports.ts`
- **Already present at base, so no new dependency:** `csv-parse` and `exceljs`, plus `packages/shared/src/index.ts` re-exporting `./imports.ts`.
- **T7 builds on this:** it uses `parseUpload`, `autoMap`, `normalizeHeader`, `HEADER_SYNONYMS` and the shared import types. T6 does no state normalization; T7 adds it with T5's `toUsStateCode` (Ruling T).
- **Minors:**
  - The "20,000" in the too-many-rows message is typed by hand rather than built from `MAX_IMPORT_ROWS`.
  - Number cells that are NaN or Infinity come out as the text 'NaN' or 'Infinity'.
  - There is an extra plain-English refusal for a CSV that can't be parsed.

## T10: inbound texts

- **Files:** `apps/api/src/hooks/twilio.ts` (`/sms` only), `apps/api/test/twilio-hooks.test.ts`, `packages/db/src/repos/inbound.ts`, `packages/db/src/system/routing.ts`.
- **Ledger minor resolved:** `insertInboundText` now uses `ON CONFLICT DO NOTHING` on the `messages_inbound_sid_uniq` index (company_id, provider_message_sid where direction='in') and returns null for a repeat. `/sms` no longer writes to `webhook_events`; the tenant transaction is the claim.
- **Signature changes** (every caller is in `hooks/twilio.ts`, which this task updated):
  - `insertInboundText` now returns `string | null`.
  - `companyContact` now also returns `email` and `website`.
  - `companyIdForNumber` takes an optional `{ includeInactive }`.
- **Minors:**
  - When OptOutType is STOP, the opt-out keyword stored is the normalized body, as the brief says. Consider capping its length.
  - The STOP/START locks are taken before the dedupe insert, which costs a little extra work on a repeat but is harmless.
  - There is no db-level test for `includeInactive`.

## T11: early delivery reports and routing by messaging service

- **Files:**
  - `apps/api/src/hooks/twilio.ts` (`/status`)
  - `apps/api/test/delivery-reports.test.ts` (new) and `apps/api/test/twilio-hooks.test.ts`
  - `packages/db/src/repos/{delivery,inbound,messages}.ts` and `packages/db/src/system/routing.ts`
- **Ruling U:** `lockDeliverySid` takes `pg_advisory_xact_lock(hashtextextended(company_id || ':' || sid, 0))`. Three paths take it:
  - `/status`: lock, then `recordDeliveryOutcome`, then `saveEarlyDeliveryReport` when the SID is unknown.
  - `applyEarlyDeliveryReports`.
  - `markTextSent`, before its UPDATE, so both paths take the advisory lock before the row lock. This was added after the group check as a hardening commit.
- **`/status` changes:**
  - It no longer uses `once`/`webhook_events`.
  - It routes by `From`, including inactive numbers, then by `MessagingServiceSid` (`/^MG[0-9a-f]{32}$/`), and otherwise answers 404.
  - `recordDeliveryOutcome` now returns `'applied' | 'ignored' | 'unknown_sid'`.
- **Test semantics changed** (please confirm):
  - The F1 test "a duplicate callback is ignored" is now "a repeated callback changes nothing once the text has moved on". Without the `webhook_events` claim, a row restored by hand to `sent` does move on a repeated `failed`.
  - The released-number `/status` test now expects 200 and the report applied, where it used to expect 404.
- **Follow-ups, not blockers:**
  - `claimWebhookEvent`/`releaseWebhookEvent` now have no production caller (keep them if the Stripe hook will use `webhook_events`).
  - Nothing prunes unapplied `early_delivery_reports`; suggest a worker sweep.
  - `texting_registrations.messaging_service_sid` has no unique index, and routing uses `limit 1`; suggest a partial unique index.

## Conflicts expected with other F3 branches

- **F3 Task 12** (send-batch) and **F3 Task 13** edit the hook and messages files after these tasks. Resolve as follows:
  - `twilio.ts`: combine the import lists. Keep `once()` only if another branch still calls it.
  - `inbound.ts`: keep T11's union return type.
  - `messages.ts`: keep the `lockDeliverySid` call at the top of `markTextSent`, and the `applyEarlyDeliveryReports` call after the row-count check.
  - `routing.ts`: keep both sides.
- **After merging:**
  - Run typecheck and lint through `ops/bin/slot`, then push `f3-setup` and let CI run the db/api suites.
  - Only the Platform job is judged, as above (the v1 job fails on these branches for the old data-file reason).

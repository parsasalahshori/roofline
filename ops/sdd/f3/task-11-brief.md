### Task 11: Delivery reports that arrive early, and reports routed by messaging service

**Base:** the Task 10 branch after it is reviewed (or `f3-setup` once Task 10 is merged). Chain: 10 → 11 → 13 (`hooks/twilio.ts`, `repos/inbound.ts`, `system/routing.ts`, `repos/messages.ts`). From Task 1: the `early_delivery_reports` table (`earlyDeliveryReports` in `schema/tenant.ts`: `companyId`, `providerMessageSid`, `status` `'delivered'|'failed'`, `reason`, `receivedAt`, `appliedAt`, unique `(company_id, provider_message_sid, status)`) and the placeholder `packages/db/src/repos/delivery.ts` (`export {};`, already in the `@roofline/db` barrel). From Task 10: `companyIdForNumber(system, e164, { includeInactive })` and `verify(…, options)`. No F2 dependency. Do not touch `apps/api/src/messaging/send-batch.ts` (F3 Task 12) or `messaging/outbound.ts`.

**Split:**
- Builder 1: `repos/delivery.ts` and the `markTextSent` hook-in (`repos/messages.ts`), plus `recordDeliveryOutcome`'s new return in `repos/inbound.ts`.
- Builder 2: the `/status` routing in `hooks/twilio.ts` and `companyIdForMessagingService` in `system/routing.ts`.
- Builder 3: `apps/api/test/delivery-reports.test.ts`.

**Files:**
- Modify: `apps/api/src/hooks/twilio.ts` (`/status`), `packages/db/src/repos/delivery.ts`, `packages/db/src/repos/messages.ts` (`markTextSent`), `packages/db/src/repos/inbound.ts` (`recordDeliveryOutcome`), `packages/db/src/system/routing.ts`
- Test: `apps/api/test/delivery-reports.test.ts` (new); `apps/api/test/twilio-hooks.test.ts` only where an F1 `/status` test asserted a `webhook_events` row.

**Interfaces:**
- **Early reports (`repos/delivery.ts`):**
```ts
export async function saveEarlyDeliveryReport(tx: Tx, ctx: TenantContext, r: { providerSid: string; status: 'delivered' | 'failed'; reason: string | null }, now: Date): Promise<void>;
export async function applyEarlyDeliveryReports(tx: Tx, ctx: TenantContext, messageId: string, providerSid: string, now: Date): Promise<'delivered' | 'failed' | null>;
```
  - `saveEarlyDeliveryReport`: insert `{ companyId, providerMessageSid, status, reason, receivedAt: now, createdAt: now, updatedAt: now }` with `ON CONFLICT DO NOTHING` (the unique constraint).
  - `applyEarlyDeliveryReports`: reads the company's unapplied reports for `providerSid` (`applied_at is null`) `FOR UPDATE`; none → null. `failed` wins over `delivered`. Failed → the message row (`id = messageId`, status `sent`) becomes `failed`, `retryable false`, `block_rule null`, `block_reason` = the stored reason; delivered → `delivered`. Every read report gets `applied_at = now`. Returns the status applied.
- **`recordDeliveryOutcome(tx, ctx, providerSid, outcome, now): Promise<'applied' | 'ignored' | 'unknown_sid'>`** (was `Promise<boolean>`): `applied` when a `sent` row moved; `ignored` when an outbound row of the company has that SID but is not `sent`; `unknown_sid` when no outbound row of the company has that SID.
- **`markTextSent`** (same signature, still returns boolean): when its update returns a row, it calls `applyEarlyDeliveryReports(tx, ctx, messageId, sent.providerSid, now)` in the same transaction before returning true.
- **Race guard (proposed Ruling T — the plan does not say how the early report and the save meet):** both `saveEarlyDeliveryReport`'s caller path and `applyEarlyDeliveryReports` first take `select pg_advisory_xact_lock(hashtextextended(${ctx.companyId} || ':' || ${providerSid}, 0))`. In `/status`, inside one `withTenant`: lock → `recordDeliveryOutcome` → on `unknown_sid`, `saveEarlyDeliveryReport`. A report and a save of the same SID then take turns, so a report is never stored after the save already looked.
- **`companyIdForMessagingService(system, messagingServiceSid): Promise<string | null>`** in `system/routing.ts`: `texting_registrations.messaging_service_sid` → `company_id`.
- **`/status` changes:**
  - The `once` claim is removed (the writes are idempotent). Remove `once`, `STATUS_EVENTS`, and the now-unused `claimWebhookEvent`/`releaseWebhookEvent` imports (lint fails on unused).
  - Route: `From` is E.164 → `companyIdForNumber(system, From, { includeInactive: true })`; else (no or non-E.164 `From`, or no company) `MessagingServiceSid` matching `/^MG[0-9a-f]{32}$/` → `companyIdForMessagingService`; else 404 with an empty body. Factor this into `verify` (or a `routeStatus` helper) so the signature is checked with that company's token, as before.
  - Outcome `delivered`/`failed`/`undelivered` as today (`outcomeOf`); on `unknown_sid` → `saveEarlyDeliveryReport` with `reason` = `CARRIER_FAILED` for a failure, null for delivered. Always 200 with an empty body.

**Tests (`delivery-reports.test.ts`)** — use `makeTestApp`, the signing helper pattern from `twilio-hooks.test.ts` (copy the small `post`/`sign` helpers; do not import from another test file), `addSmsCustomers`/`approvedBatch` from `./sms-helpers.ts`. Define the held adapter **locally in this file**:
```ts
/** Holds every send until release(); then answers with the given SID. */
class ReleasableSmsAdapter implements SmsAdapter {
  private readonly gate = gate();            // from ./sms-helpers.ts
  constructor(private readonly sid: string) {}
  async send(): Promise<SmsSendResult> { await this.gate.opened; return { providerSid: this.sid, segments: 1 }; }
  release(): void { this.gate.open(); }
}
const SID = 'SM' + 'b'.repeat(32);
```
- `test('a delivered report that beats the saved SID is applied when the send is saved')`: start a one-text send with the held adapter (not awaited); while held, POST `/status` `MessageSid=SID, MessageStatus=delivered, From=<Acme number>` → 200 and one `early_delivery_reports` row; `release()`, await the send → the message row is `delivered`; the report has `applied_at` set.
- `test('an early failed report fails the text')`: same with `MessageStatus=failed` → row `failed`, `retryable false`, `block_reason "The carrier couldn't deliver this text."`.
- `test('a repeated report changes nothing and stores nothing')`: an early `delivered` posted twice → one report row; after the save, posting `delivered` again → 200, still one report row, row still `delivered`.
- `test('a report for a number that is no longer active is applied')`: a `sent` text; set Acme's number `status` to `'released'`; POST `delivered` with `From` = that number → `delivered`.
- `test('a report with no From is routed by its messaging service')`: set `texting_registrations.messaging_service_sid = 'MG' + 'c'.repeat(32)` for Acme; POST without `From`, with `MessagingServiceSid` → applied; an unknown `MG…` → 404.
- `test('delivery reports no longer use webhook_events')`: after a report, `select count(*) from webhook_events where provider = 'twilio-status'` = 0.

**Verify notes:**
- The api/db suites need Docker; there is none here. Locally: `npm run typecheck && npm run lint`. Prove the tests, including every F1 `twilio-hooks` and `send-batch`/`dispatcher` test, with `ops/bin/ci-check`.
- Commit: `fix(hooks): keep delivery reports that arrive before the send is saved; route by messaging service`.

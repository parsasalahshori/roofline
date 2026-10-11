### Task 13: Twilio sending: HTTP client, SMS adapter, sender wiring, carrier opt-outs

**Base:** `f3-setup` after Tasks 9 and **11** are merged (8, 10 and 12 already are). Chain: 10 → 11 → 13 on `repos/messages.ts`; 12 → 13 on `messaging/send-batch.ts`. From T8: `SmsRefusedError` (`permanent`, `optedOut`, `reasonPlain`), `isSmsRefusedError`, `OutboundSms.sender`, `FakeSmsAdapter.refuseNext(n, opts)` and its `sent[i].sender` recording — all in `@roofline/send-gate`. From T9: the stub `providers/twilio/sms.ts` (`twilioSmsFor(config): SmsAdapter | null`) that `createSmsAdapter` already calls, and config `TWILIO_ACCOUNT_SID`. From T12: the lease line in `send-batch.ts`.
**Carry (must stay exactly):** the first statement inside `send-batch.ts`'s `for (const customerId of customerIds)` loop is
```ts
if (!(await lease.keep())) return { status: 'running', result: {} };
```
Do not move, wrap or reorder it.

**Split:**
- Builder 1: `apps/api/src/providers/twilio/http.ts` and `apps/api/src/providers/twilio/sms.ts`, plus `apps/api/test/twilio-sms.test.ts`.
- Builder 2: the sender through `packages/db/src/repos/messages.ts` (`textingCompanyFacts`), `apps/api/src/messaging/{gate-request,outbound,send-batch,dispatcher}.ts`.
- Builder 3: `packages/db/src/repos/opt-outs.ts` (`recordCarrierOptOut`) and the `send-batch.test.ts` integration tests.

**Files:**
- Create: `apps/api/src/providers/twilio/http.ts`
- Modify: `apps/api/src/providers/twilio/sms.ts` (replace T9's stub), `packages/db/src/repos/messages.ts` (`TextingCompanyFacts`/`textingCompanyFacts` only), `packages/db/src/repos/opt-outs.ts` (replace T1's placeholder; already in the barrel), `apps/api/src/messaging/{gate-request,outbound,send-batch,dispatcher}.ts`
- Test: `apps/api/test/twilio-sms.test.ts` (new), `apps/api/test/send-batch.test.ts` (extend)
- Do not touch: `providers/sms.ts` (factory, T9), `hooks/twilio.ts`, `repos/inbound.ts` (import from it only), `config.ts`.

**Interfaces:**
- **HTTP client (`providers/twilio/http.ts`)** — T25/T26 reuse it:
```ts
export const TWILIO_API = 'https://api.twilio.com/2010-04-01', TWILIO_MESSAGING = 'https://messaging.twilio.com/v1', TWILIO_TRUSTHUB = 'https://trusthub.twilio.com/v1';
export class TwilioApiError extends Error { readonly status: number; readonly code: number | null }    // message never includes Twilio's text: `Twilio refused the request (status ${status}, code ${code ?? 'none'}).`
export class TwilioUnreachableError extends Error {}                                                   // "Twilio didn't answer."
export class TwilioHttp { constructor(o: { accountSid: string; authToken: string; fetch?: typeof fetch; timeoutMs?: number });
  as(sub: { accountSid: string; authToken: string }): TwilioHttp;   // same fetch and timeout, other credentials
  request<T>(method: 'GET' | 'POST' | 'DELETE', url: string, params?: Record<string, string | string[] | undefined>): Promise<T> }
```
  - Basic auth `base64(accountSid:authToken)`. POST is `application/x-www-form-urlencoded` (arrays repeat the key; `undefined` values left out). GET/DELETE put params in the query string.
  - Timeout 10 s by default (`AbortSignal.timeout`).
  - 400–499 → `TwilioApiError` with the JSON body's numeric `code` (null if unreadable). Network error, timeout, 5xx, or an unreadable 2xx body → `TwilioUnreachableError`. 204 → `undefined as T`.
  - No error message, and nothing logged, ever contains the URL's query, a phone number, a body or Twilio's `message`.
- **SMS adapter (`providers/twilio/sms.ts`):**
```ts
export class TwilioSmsAdapter implements SmsAdapter { constructor(o: { http: TwilioHttp; statusCallbackUrl: string }) }
export function twilioSmsFor(config: Config): SmsAdapter | null;   // TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN → TwilioSmsAdapter with `${PUBLIC_BASE_URL}/hooks/twilio/status`; else null
```
  - **Request:** `POST ${TWILIO_API}/Accounts/${sender.accountSid}/Messages.json` with exactly `To`, `MessagingServiceSid`, `Body`, `StatusCallback`, on the **master** credentials (Ruling 28).
  - **Result:** `{ providerSid: json.sid, segments: parseInt(json.num_segments, 10) || countSegments(body) }`.
  - **Refusals** (`SmsRefusedError` message is always generic, e.g. "Twilio refused the text."):
    - code 21610 → `{ permanent: true, optedOut: true, reasonPlain: "This person turned off texts from your number, so we stopped texting them." }`
    - codes 21211, 21612, 21614, 21408, 21265 → `{ permanent: true, reasonPlain: "This number can't get texts." }`
    - status 429 or code 20429 → refused, retryable (no opts)
    - any other 4xx → refused, retryable
    - `TwilioUnreachableError` → `throw new Error('Twilio did not confirm the text.')` (outcome unknown)
    - no `sender` → `new SmsRefusedError("Texting isn't set up yet.")`
- **Sender wiring:**
  - `TextingCompanyFacts` gains `sender: { accountSid: string; messagingServiceSid: string } | null` — from `texting_registrations.subaccount_sid` and `.messaging_service_sid` (both tenant-readable, migration 0003); null unless both are set.
  - `BuiltGateRequest` gains `sender` (copied from the company facts); `QueuedText` (`outbound.ts`) gains `sender: { accountSid; messagingServiceSid } | null`; every place that builds a `QueuedText` (send-batch's `decideOne`, the dispatcher) passes it on; `sendQueuedText` calls `deps.sms.send({ companyId, to, body, sender: text.sender })`.
- **`sendQueuedText`** — return type becomes `'sent' | 'refused' | 'failed' | 'unknown'`; uses `isSmsRefusedError(err)` instead of `instanceof`:
  - **permanent** refusal → `markTextFailed(…, { reason: err.reasonPlain ?? refusedReason, retryable: false })` and, when `err.optedOut`, `recordCarrierOptOut(tx, ctx, text.to, now)` **in the same transaction**; returns `'failed'` (so a batch does not throw for it).
  - other refusal → as today (`failed`, retryable, `refusedReason`) → `'refused'`.
  - any other error → as today (`UNCONFIRMED`) → `'unknown'`.
  - Update `send-batch.ts` and `dispatcher.ts` call sites for the new `'failed'` value (dispatcher already maps non-`sent` to `'failed'`).
- **Carrier opt-outs (`repos/opt-outs.ts`):** `recordCarrierOptOut(tx: Tx, ctx: TenantContext, phoneE164: string, now: Date): Promise<string[]>`
  - `customersWithPhone` + `lockRecipients` (from `./inbound.ts`) for every customer with the phone, then lock their consent rows (`SELECT … FOR UPDATE` ordered by id).
  - Upsert `opt_outs` `{ phoneE164, keyword: 'carrier' }` with `ON CONFLICT DO NOTHING` (an earlier STOP keeps its keyword).
  - Revoke every non-revoked one: `sms_consent_status 'revoked'`, source `text`, at `now`, by null.
  - Per revoked customer: audit `customer.consent_revoked` with `after.via = 'carrier'`, and activity "The texting service says this person opted out. Texting is turned off." (`addActivity`).
  - Returns the revoked customer ids.

**Tests:**
- `twilio-sms.test.ts` (an injected `fetch` that records method, URL, headers, body):
  - success (`{ sid: 'SM'+'a'.repeat(32), num_segments: '2' }`) → `{ providerSid, segments: 2 }`; URL `…/Accounts/AC<sub>/Messages.json` uses the **subaccount** SID; `Authorization` is Basic of the **master** SID:token; the form has exactly `To`, `MessagingServiceSid`, `Body`, `StatusCallback`.
  - 400 `{code:21610}` → `SmsRefusedError` permanent + optedOut with the reason; 400 `{code:21614}` → permanent "This number can't get texts."; 429 `{code:20429}` → refused, not permanent; 500 → plain `Error('Twilio did not confirm the text.')`; a fetch that never resolves with `timeoutMs: 50` → same.
  - No error's `message` contains `+1402` or the body text.
  - No `sender` → "Texting isn't set up yet."; `twilioSmsFor` null without both credentials.
- `send-batch.test.ts` (extend):
  - `test('a carrier opt-out turns texting off for that customer')`: `t.sms.refuseNext(1, { permanent: true, optedOut: true, reasonPlain: R })` → the row is `failed`, `retryable false`, `block_reason R`; `opt_outs.keyword = 'carrier'`; the customer is `revoked`; the step is `done` (the queue holds no retry).
  - `test("texts go out on the company's texting account")`: set the registration's `subaccount_sid = 'AC'+'1'.repeat(32)` and `messaging_service_sid = 'MG'+'2'.repeat(32)` (owner client) → `t.sms.sent[0].sender` equals `{ accountSid, messagingServiceSid }`.
  - `test('an earlier STOP keeps its keyword when the carrier also reports it')`.

**Verify notes:**
- api/db suites need Docker (none here): locally `npm run typecheck && npm run lint`; prove with `ops/bin/ci-check`. The F1 `send-batch`, `dispatcher`, `lease-heartbeat` and `twilio-hooks` tests must stay green.
- Commit: `feat(texting): send through Twilio on the company's messaging service; honor carrier opt-outs`.

### Task 10: Inbound texts: atomic claim, carrier opt-out keywords, short codes, inactive numbers, HELP contact

**Base:** `f3-setup` after F3 Task 1 is merged (or stacked on `f3-t1`). It needs Task 1's partial unique index `messages_inbound_sid_uniq` on `messages (company_id, provider_message_sid) WHERE direction = 'in'` (in `0010_f3_schema.sql` and `schema/tenant.ts`). No F2 dependency; none of F2 T6–T9 touch these files. **Chain:** Task 11 edits the same three source files (`hooks/twilio.ts`, `repos/inbound.ts`, `system/routing.ts`) and runs after this one; F3 Task 13 after that. Do not touch `/status` (Task 11's).

**Split:**
- Builder 1: `packages/db/src/repos/inbound.ts` (`insertInboundText`, `companyContact`).
- Builder 2: `packages/db/src/system/routing.ts` (`companyIdForNumber`'s option).
- Builder 3: `apps/api/src/hooks/twilio.ts` for `/sms`, plus the tests in `apps/api/test/twilio-hooks.test.ts`.

**Files:**
- Modify: `apps/api/src/hooks/twilio.ts` (the `/sms` path, `handleInbound`, `reply.help`, and `verify` — routing only), `packages/db/src/repos/inbound.ts`, `packages/db/src/system/routing.ts`
- Test: `apps/api/test/twilio-hooks.test.ts` (extend; signed the way the existing tests sign)
- Do not touch: the `/status` handler, `once`/`claimWebhookEvent`/`releaseWebhookEvent` (still used by `/status` until Task 11), any barrel (both modules are already exported), migrations.

**Interfaces (current code → new):**
- **`insertInboundText(tx, ctx, text: InboundText, now): Promise<string | null>`** (was `Promise<string>`): the same insert plus `.onConflictDoNothing({ target: [messages.companyId, messages.providerMessageSid], where: sql\`${messages.direction} = 'in'\` })` (the predicate lets Postgres infer the partial index), `.returning({ id })`; returns null for a repeat. `InboundText.fromE164` now also carries a short code.
- **`companyContact(tx, ctx): Promise<{ name: string; phoneE164: string | null; email: string | null; website: string | null } | null>`** — adds `companies.email` and `companies.website`.
- **`companyIdForNumber(system, e164, options?: { includeInactive?: boolean }): Promise<string | null>`**: unchanged by default (active numbers only); with `includeInactive: true`, the number's company whatever its `status` (`company_phone_numbers.e164` is unique, so there is at most one row).
- **`/sms` changes** in `hooks/twilio.ts`:
  - `verify(deps, req, res, 'To', { includeInactive: true })` — give `verify` an optional options argument passed to `companyIdForNumber`; `/status` keeps calling it without one.
  - The `webhook_events` claim (`once(deps, SMS_EVENTS, …)`) is removed from `/sms`; drop the now-unused `SMS_EVENTS` constant. The tenant transaction is the claim: `handleInbound` inserts first (after the STOP/START locks), and a null insert returns no reply and does nothing else (no opt-out, no flag). A throw rolls everything back and answers 500, so Twilio's retry is handled.
  - `From` may be E.164 or a short code `/^\d{3,8}$/` (new `SHORT_CODE` regex):
    - A short-code text is stored (`from_e164` = the raw value, `customerId` null), never classified (no `readInbound`, no locks, no flag), and answered with an empty `<Response/>`.
  - **`OptOutType` form field** (Twilio Advanced Opt-Out): when it is `STOP`, `START` or `HELP` it overrides `readInbound(body)`. For `STOP` the keyword passed to `revokeConsentByText` is the normalized body (`body.trim().toUpperCase()`, or `'STOP'` when empty). Any other value is ignored.
  - **Replies:** with `OptOutType` `STOP` or `START`, our TwiML reply is omitted (`<Response/>`), because Twilio already sent one. `HELP` is always answered by us.
  - **HELP reply,** first available contact (all dynamic parts through `escapeXml`):
    - phone → `${name}: call us at ${displayPhone(phoneE164)}. Reply STOP to opt out.`
    - email → `${name}: email us at ${email}. Reply STOP to opt out.`
    - website → `${name}: visit ${website}. Reply STOP to opt out.`
    - else the number they texted → `${name}: call or text us at ${displayPhone(To)}. Reply STOP to opt out.`
    - `reply.help` becomes `help(contact: { name; phoneE164; email; website }, to: string)`. The old "`${name}. Reply STOP to opt out.`" branch goes away.
  - Keep the module's top comment accurate: step 4 (dedupe) now says `/sms` dedupes inside the tenant transaction.

**Tests (`twilio-hooks.test.ts`, extend; reuse its existing signing/post helpers):**
- `test('a STOP whose work fails is handled on the retry')`: through the owner client create a one-row flag table and a `BEFORE INSERT` trigger on `opt_outs` that raises while the flag is set and clears it (so it fails once). First POST → 500; no `messages` row with that SID; no opt-out. Second POST (same SID) → 200 with the STOP reply; exactly one opt-out and one `customer.consent_revoked` audit row. Drop the trigger and table in `finally`.
- `test('two copies of one STOP at once make one opt-out and one reply')`: `Promise.all` of two identical POSTs → exactly one body contains `unsubscribed`; the other is `<Response/>`; one `messages` row, one opt-out.
- `test('texts that come in no longer use webhook_events')`: after an inbound text, `select count(*) from webhook_events where provider = 'twilio-sms'` = 0.
- `test('a short-code sender is stored and changes nothing')`: `From=72345`, `Body=STOP` → `<Response/>`; the row's `from_e164 = '72345'`; no opt-out.
- `test('a STOP to a number that is no longer active still opts out')`: set the company's number `status` to something other than `active`; STOP → 200 with the STOP reply and an opt-out.
- `test('HELP falls back to email, website, then the number they texted')`: for Acme Roofing with `phone_e164` null: with `email = 'office@acme.test'` → `Acme Roofing: email us at office@acme.test. Reply STOP to opt out.`; with email null and `website = 'https://acme.test'` → `Acme Roofing: visit https://acme.test. Reply STOP to opt out.`; with both null and `To=+14025550100` → `Acme Roofing: call or text us at (402) 555-0100. Reply STOP to opt out.` (set the company columns through the owner client; `+14025550100` is the file's `A_NUMBER`, Acme's texting number).
- `test("Twilio's own opt-out keyword counts and we don't answer twice")`: `OptOutType=STOP` with `Body=OPTOUT` → opted out (keyword `OPTOUT`), `<Response/>`; `OptOutType=START` → restored, `<Response/>`; `OptOutType=HELP` (any body) → our HELP text.
- Existing F1 tests in the file must still pass; adjust only those that asserted a `webhook_events` row for `/sms` or the old no-phone HELP text.

**Verify notes:**
- The `@roofline/api` suite needs Docker (Testcontainers); there is none here. Locally: `npm run typecheck && npm run lint`. Prove the tests with `ops/bin/ci-check` (judges the Platform job, which runs the full api/db suites on GitHub).
- Commit: `fix(hooks): inbound dedupe inside the tenant transaction; carrier opt-outs, short codes, inactive numbers, HELP contact`.

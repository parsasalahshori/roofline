### Task 25: Twilio registrar: subaccounts, messaging services, numbers

**Base:** `f3-setup` after Tasks 9 and **13** are merged. From T13: `apps/api/src/providers/twilio/http.ts` (`TwilioHttp`, `.as(sub)`, `TWILIO_API`, `TWILIO_MESSAGING`, `TwilioApiError`, `TwilioUnreachableError`). From T9: `providers/registrar.ts` (`TextingAccounts`, `SubaccountRef`, `RegistrarUnavailableError`, `RegistrarRejectedError`), the stub `providers/twilio/accounts.ts` (`twilioAccountsFor(config): TextingAccounts | null`, already composed by `createRegistrar`), config `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`PUBLIC_BASE_URL`.
**Shared test helper (proposed Ruling AD):** this task creates `apps/api/test/twilio-fixtures.ts` (`fixtureFetch`). T26 and T28 import it and do not edit it, so **T26 is stacked on this task's branch** (see the groups in the ledger).

**Split:**
- Builder 1: `apps/api/src/providers/twilio/accounts.ts`.
- Builder 2: `apps/api/test/twilio-fixtures.ts` and the ten fixtures.
- Builder 3: `apps/api/test/twilio-accounts.test.ts` and `twilioAccountsFor` wiring.

**Files:**
- Create: `apps/api/test/twilio-fixtures.ts`, `apps/api/test/fixtures/twilio/{accounts-empty,account-create,services-empty,service-create,service-numbers-empty,service-numbers-one,available-402,available-empty,incoming-create,service-number-add}.json`
- Modify: `apps/api/src/providers/twilio/accounts.ts` (replace the stub)
- Test: `apps/api/test/twilio-accounts.test.ts`
- Do not touch: `providers/registrar.ts`, `providers/twilio/{http,sms,brands}.ts`.

**Interfaces:**
```ts
// providers/twilio/accounts.ts
export class TwilioAccounts implements TextingAccounts { constructor(o: { http: TwilioHttp }) }
export function twilioAccountsFor(config: Config): TextingAccounts | null;   // TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN → new TwilioAccounts({ http: new TwilioHttp({ accountSid, authToken }) }); else null
// test/twilio-fixtures.ts
export function fixtureFetch(routes: Record<string, string | string[]>): typeof fetch & {
  requests: { method: string; url: string; auth: string; form: URLSearchParams | null; json: unknown }[] };
// key 'METHOD <url prefix>' → a fixture file name under test/fixtures/twilio (without .json), or a list served in order (the last repeats);
// the longest matching prefix wins; an unmatched request rejects with an Error naming METHOD and path (fails the test)
export function fixture(name: string): unknown;   // reads test/fixtures/twilio/<name>.json
```
- **`ensureSubaccount(companyId)`** (master credentials): `GET ${TWILIO_API}/Accounts.json?FriendlyName=roofline:<companyId>&Status=active` → reuse `accounts[0]`; else `POST ${TWILIO_API}/Accounts.json { FriendlyName: 'roofline:<companyId>' }` → `{ accountSid: sid, authToken: auth_token }`.
- **`ensureMessagingService(sub, companyId, urls)`** (as the subaccount, `http.as(sub)`): `GET ${TWILIO_MESSAGING}/Services?PageSize=50`, match `friendly_name === 'Roofline <companyId>'`; found → `POST /Services/{sid} { InboundRequestUrl, StatusCallback }` (keep the URLs current); else `POST /Services { FriendlyName, InboundRequestUrl: urls.inbound, InboundMethod: 'POST', StatusCallback: urls.status, UseInboundWebhookOnNumber: 'false' }` → `{ messagingServiceSid: sid }`.
- **`ensureNumber(sub, { messagingServiceSid, areaCode, state })`** (as the subaccount):
  1. `GET ${TWILIO_MESSAGING}/Services/{MG}/PhoneNumbers` — a number already there → return it (`phone_number`, `sid`, `capabilities` normalized to `('sms'|'voice')[]`).
  2. Else `GET ${TWILIO_API}/Accounts/{sub}/IncomingPhoneNumbers.json?PageSize=20` (as the subaccount): a number the subaccount already owns but has not attached (an earlier attempt bought it and the attach failed) → `owned` = the first; skip the search and the purchase.
  3. Else search `GET ${TWILIO_API}/Accounts/{sub}/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true&VoiceEnabled=true&PageSize=1`, first with `AreaCode` (when given), then `InRegion=<state>` (when given), then unfiltered; nothing at all → `RegistrarUnavailableError('No numbers were available.')`. Buy it: `POST ${TWILIO_API}/Accounts/{sub}/IncomingPhoneNumbers.json { PhoneNumber }` → `owned`.
  4. Attach: `POST ${TWILIO_MESSAGING}/Services/{MG}/PhoneNumbers { PhoneNumberSid: owned.sid }`. A `TwilioApiError` with code 21710 (already on the service) counts as success; anything else is rethrown (mapped to `RegistrarUnavailableError`). Return `{ e164: owned.phone_number, phoneNumberSid: owned.sid, capabilities }`.
- **Credentials:** Messaging and TrustHub calls authenticate as the subaccount (`http.as(sub)`); 2010-API calls for the subaccount use the `/Accounts/{sub}/…` path with the subaccount credentials too.
- **Errors:** `TwilioUnreachableError` → `RegistrarUnavailableError("Twilio didn't answer.")`; `TwilioApiError` → `RegistrarUnavailableError` with the code only (these are setup calls; a refusal is not the customer's to fix). No Twilio text in any message.

**Tests (`twilio-accounts.test.ts`)** — `fixtureFetch`; config URLs `https://app.roofline.test`:
- `test('creates a subaccount once')`: `accounts-empty` → one `POST /Accounts.json` with `FriendlyName=roofline:<id>`; a list with one → no POST and the listed sid/token.
- `test('the messaging service points at our hooks')`: the form has `InboundRequestUrl=https://app.roofline.test/hooks/twilio/sms` and `StatusCallback=https://app.roofline.test/hooks/twilio/status`, `UseInboundWebhookOnNumber=false`.
- `test("a number in the company's area code")`: `AreaCode=402` → `{ e164: '+14025550123', capabilities: ['sms','voice'] }`; then the service-number add with that `PhoneNumberSid`.
- `test('falls back to the state, then anywhere')`: `available-empty` for the area code, then for `InRegion=NE`, then `available-402` unfiltered; all three empty → `RegistrarUnavailableError` "No numbers were available."
- `test('reuses a number already on the service')`: `service-numbers-one` → no search, no purchase.
- `test("messaging calls use the subaccount's own credentials")`: the `Authorization` header of the `/Services` calls is Basic of the **subaccount** SID; `ensureSubaccount`'s is the master's.

**Verify notes:**
- api project needs Docker for its globalSetup (none here): locally `npm run typecheck && npm run lint`; prove with `ops/bin/ci-check`.
- Commit: `feat(texting): Twilio subaccounts, messaging services and local numbers`.

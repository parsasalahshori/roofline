### Task 26: Twilio registrar: business profile, brand and campaign

**Base:** stacked on the **Task 25** branch (Ruling AD: it imports T25's `apps/api/test/twilio-fixtures.ts`, `fixtureFetch`/`fixture`); T5, T9 and T13 are in. From T13: `TwilioHttp`, `TWILIO_API`, `TWILIO_MESSAGING`, `TWILIO_TRUSTHUB`, `TwilioApiError`, `TwilioUnreachableError`. From T9: `TextingBrands`, `SubaccountRef`, `ReviewStatus`, `RegistrarRejectedError`, `RegistrarUnavailableError`, the stub `providers/twilio/brands.ts` (`twilioBrandsFor(config): TextingBrands | null`), config `TWILIO_PRIMARY_PROFILE_SID`. From T5 (`@roofline/shared`): `BrandInfo`, `CampaignInfo`, `buildCampaign`.

**Split:**
- Builder 1: `brands.ts` — `submitBrand` and `brandStatus`.
- Builder 2: `brands.ts` — `submitCampaign` and `campaignStatus` (bottom half; the lead joins).
- Builder 3: the 17 fixtures and `apps/api/test/twilio-brands.test.ts`.

**Files:**
- Create: `apps/api/test/fixtures/twilio/{profile-create,enduser-create,address-create,document-create,assignment-create,evaluation-compliant,evaluation-noncompliant,profile-submit,trust-create,brand-create,brand-pending,brand-approved,brand-failed,campaign-create,campaign-pending,campaign-verified,campaign-failed,assignments-list,enduser-get-business,enduser-get-rep,document-get,enduser-update,address-update}.json` (the last six for the in-place resubmit, Ruling AL)
- Modify: `apps/api/src/providers/twilio/brands.ts` (replace the stub)
- Test: `apps/api/test/twilio-brands.test.ts`
- Do not touch: `test/twilio-fixtures.ts` (T25's; if it truly lacks something, the lead adds it and says so), `providers/twilio/accounts.ts`.

**Interfaces:**
```ts
export const SECONDARY_PROFILE_POLICY = 'RNdfbf3fae0e1107f8aded0e7cead80bf5';   // confirm against Twilio's ISV guide in the manual smoke (T37)
export const A2P_PROFILE_POLICY = 'RNb0d4771c2c98518d916a3d4cd70a8f8b';
export class TwilioBrands implements TextingBrands { constructor(o: { http: TwilioHttp; primaryProfileSid: string }) }
export function twilioBrandsFor(config: Config): TextingBrands | null;   // TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PRIMARY_PROFILE_SID → TwilioBrands; else null
```
- **`submitBrand(sub, { companyId, brand, statusCallback, previous })`**, as the subaccount, in order (TrustHub paths under `TWILIO_TRUSTHUB`):
  1. `POST /CustomerProfiles { FriendlyName: 'Roofline <companyId>', Email: contactEmail, PolicySid: SECONDARY_PROFILE_POLICY, StatusCallback }`, or reuse `previous.customerProfileSid`. With a reused profile (a resubmission after the owner fixed details), steps 2–4 **update in place** instead of creating (proposed Ruling AL): `GET /CustomerProfiles/{BU}/EntityAssignments`, then for each assigned object `GET /EndUsers/{sid}` (or `/SupportingDocuments/{sid}`) to find it by `type`, and `POST /EndUsers/{sid} { Attributes }` with the corrected attributes; the address is updated with `POST ${TWILIO_API}/Accounts/{sub}/Addresses/{AD}.json` (the `AD` sid read from the supporting document's `attributes.address_sids`). Step 5 is skipped (already assigned); steps 6–9 run. A reused `previous.trustProductSid` skips creating the trust product and its EndUser in step 8 but re-evaluates and resubmits it. T37's real-brand smoke confirms this flow against Twilio.
  2. `POST /EndUsers { FriendlyName, Type: 'customer_profile_business_information', Attributes: JSON }` with `business_name` = `legalName`, `business_identity: 'direct_customer'`, `business_type` (`llc` → `Limited Liability Corporation`, `corporation` → `Corporation`, `partnership` → `Partnership`, `non_profit` → `Non-profit Corporation`), `business_industry: 'CONSTRUCTION'`, `business_registration_identifier: 'EIN'`, `business_registration_number` = the EIN digits (no dash), `business_regions_of_operation: 'USA_AND_CANADA'`, `website_url`. Then `POST /CustomerProfiles/{BU}/EntityAssignments { ObjectSid }`.
  3. `POST /EndUsers { Type: 'authorized_representative_1', Attributes: { first_name, last_name, email, phone_number, business_title: contactTitle, job_position: 'Other' } }`, then assign it.
  4. `POST ${TWILIO_API}/Accounts/{sub}/Addresses.json { CustomerName: legalName, Street, City, Region, PostalCode, IsoCountry: 'US' }`, then `POST /SupportingDocuments { FriendlyName, Type: 'customer_profile_address', Attributes: { address_sids } }`, then assign it.
  5. Assign `primaryProfileSid`.
  6. `POST /CustomerProfiles/{BU}/Evaluations { PolicySid }`; `status: 'noncompliant'` → `RegistrarRejectedError` with the first failing requirement's `friendly_name` (from `results[].fields[]` where `passed === false`).
  7. `POST /CustomerProfiles/{BU} { Status: 'pending-review' }`.
  8. `POST /TrustProducts { FriendlyName, Email, PolicySid: A2P_PROFILE_POLICY }` (or reuse `previous.trustProductSid`), EndUser `us_a2p_messaging_profile_information { company_type: 'private' }` assigned to it, assign the customer profile `{BU}`, evaluate (same rule), then `POST /TrustProducts/{BU2} { Status: 'pending-review' }`.
  9. `POST ${TWILIO_MESSAGING}/a2p/BrandRegistrations { CustomerProfileBundleSid, A2PProfileBundleSid, BrandType: 'STANDARD' }`; with `previous.brandSid` (a failed brand) `POST /a2p/BrandRegistrations/{BN}` resubmits instead.
  → `{ customerProfileSid, trustProductSid, brandSid }`.
- **`brandStatus(sub, brandSid)`:** `GET ${TWILIO_MESSAGING}/a2p/BrandRegistrations/{BN}`; `status` `APPROVED` → `approved`; `FAILED` → `failed` with `failure_reason`; else `pending`.
- **`submitCampaign(sub, { brandSid, messagingServiceSid, campaign, previousCampaignSid })`:** with `previousCampaignSid`, first `DELETE ${TWILIO_MESSAGING}/Services/{MG}/Compliance/Usa2p/{QE}`. Then `POST /Services/{MG}/Compliance/Usa2p` with `BrandRegistrationSid`, `Description`, `MessageFlow`, `MessageSamples` (repeated key), `UsAppToPersonUsecase: 'MIXED'`, `HasEmbeddedLinks: 'true'`, `HasEmbeddedPhone: 'true'`, `OptInMessage`, `OptOutMessage`, `HelpMessage`, `OptInKeywords: 'START'`, `OptOutKeywords: 'STOP'`, `HelpKeywords: 'HELP'` → `{ campaignSid: sid }`.
- **`campaignStatus(sub, MG, QE)`:** `GET …/Usa2p/{QE}`; `campaign_status` `VERIFIED` → `approved`; `FAILED` or `EXPIRED` → `failed` with `errors[0].description` (null when absent); else `pending`.
- **Errors:** a `TwilioApiError` on any POST of steps 1–9 or the campaign POST → `RegistrarRejectedError` whose `reasonText` is `Twilio error ${code}` (code only; T5's `plainRejection` turns it into the fallback reason); `TwilioUnreachableError` → `RegistrarUnavailableError("Twilio didn't answer.")`. The `failure_reason`/`description` read from status answers is passed through as `failureReason` only (T27/T28 run it through `plainRejection`; it is never shown raw).

**Tests (`twilio-brands.test.ts`)** — `fixtureFetch` from `./twilio-fixtures.ts`; `buildCampaign({ companyName: 'Acme Roofing', companyPhone: '+14025550199', privacyUrl: 'P', termsUrl: 'T' })`:
- `test('submits the business profile, the messaging profile and the brand, in order')`: the exact list of `METHOD path` of `requests` (19-ish entries; write it out).
- `test('maps the business type and EIN')`: the business EndUser `Attributes` JSON equals the expected object for an `llc` with EIN `12-3456789` (`business_registration_number: '123456789'`).
- `test('a non-compliant evaluation is a rejection with a plain reason')`: `evaluation-noncompliant` → `RegistrarRejectedError` whose `reasonText` is the failing requirement's `friendly_name`.
- `test('brand statuses')`: pending, approved, and failed with its reason.
- `test('the campaign uses the mixed use case and our samples')`: `form.getAll('MessageSamples')` equals `campaign.samples`; `UsAppToPersonUsecase=MIXED`.
- `test('resubmitting a failed campaign deletes the old one first')`: a `DELETE …/Usa2p/QE…` precedes the POST.
- `test('campaign statuses')`: verified, failed with `errors[0].description`, pending.
- `test('resubmitting a fixed brand updates the profile in place')`: with `previous` sids → no `POST /CustomerProfiles`, a `POST /EndUsers/{sid}` with the corrected `business_registration_number`, then evaluation, submit and `POST /a2p/BrandRegistrations/{BN}`.
- `test('every TrustHub and Messaging call uses the subaccount credentials')`.

**Verify notes:**
- api project needs Docker for its globalSetup (none here): locally `npm run typecheck && npm run lint`; prove with `ops/bin/ci-check`.
- Commit: `feat(texting): Twilio business profile, A2P brand and mixed campaign`.

### Task 5: Shared texting registration details (brand fields, campaign text, rejection reasons, view)

**Base:** `f3-setup` after F3 Task 1 is merged (or stacked on `f3-t1`). Task 1 left `packages/shared/src/texting.ts` as `export {};` (already in the shared barrel). `toE164` is in `packages/shared/src/phone.ts`; `zod` ^4 is already a dependency of `@roofline/shared`. No F2 dependency.

**Split:**
- Builder 1: `BrandInfoSchema` and the field messages in `texting.ts`, plus the US-state helpers in `address.ts` (proposed Ruling S below).
- Builder 2: `buildCampaign`, `displayUsPhone`, `plainRejection`, `TEXTING_STATES`, `TextingView` in `texting.ts` (below Builder 1's half; the lead joins).
- Builder 3: `packages/shared/test/texting.test.ts` and the `address.test.ts` additions.

**Files:**
- Modify: `packages/shared/src/texting.ts` (replace the placeholder), `packages/shared/src/address.ts` (append the state helpers)
- Test: `packages/shared/test/texting.test.ts` (new), `packages/shared/test/address.test.ts` (extend)
- Do not touch: `packages/shared/src/index.ts`, `packages/shared/src/phone.ts` (F3 Task 8 edits it).

**Interfaces:**
```ts
export const BUSINESS_TYPES = ['llc', 'corporation', 'partnership', 'non_profit'] as const; export type BusinessType = (typeof BUSINESS_TYPES)[number];
export const BRAND_FIELDS = ['legalName','ein','businessType','street','city','state','zip','website',
  'contactFirstName','contactLastName','contactEmail','contactPhone','contactTitle'] as const; export type BrandField = (typeof BRAND_FIELDS)[number];
export type BrandInfo = Omit<Record<BrandField, string>, 'businessType'> & { businessType: BusinessType };
export const BrandInfoSchema: z.ZodType<BrandInfo, unknown>;   // output BrandInfo; input is whatever the form sent (transforms normalize)
export type CampaignInfo = { useCase: 'MIXED'; description: string; messageFlow: string; samples: string[];
  optInMessage: string; optOutMessage: string; helpMessage: string; privacyUrl: string; termsUrl: string;
  hasEmbeddedLinks: true; hasEmbeddedPhone: true };
export const USE_CASE_LABEL = 'Customer care + marketing (mixed)';
export function displayUsPhone(e164: string): string;   // '+14025550199' → '(402) 555-0199'; anything else unchanged
export function buildCampaign(input: { companyName: string; companyPhone: string | null; privacyUrl: string; termsUrl: string }): CampaignInfo;
export function plainRejection(failureText: string | null): { reason: string; fields: BrandField[] };
export const TEXTING_STATES = ['not_started', 'waiting', 'approved', 'needs_fix'] as const; export type TextingState = (typeof TEXTING_STATES)[number];
export type TextingView = { state: TextingState; reason: string | null; rejectedFields: BrandField[]; brand: BrandInfo | null;
  defaults: Partial<BrandInfo>; submittedAt: string | null; approvedAt: string | null; number: string | null;
  needsPaymentMethod: boolean; needsVerifiedEmail: boolean; hostedPolicyUrls: { privacy: string; terms: string } };
```
- **State helpers (`address.ts`, proposed Ruling S):**
```ts
export const US_STATE_NAMES: Readonly<Record<string, string>>;   // 'AL' → 'Alabama' … 50 states + 'DC' → 'District of Columbia' (51 entries)
export function toUsStateCode(value: string): string | null;     // trims, drops a trailing '.', case-insensitive; a code or a full name → the code; else null
```
  `toUsStateCode('ne') === 'NE'`, `toUsStateCode('NE.') === 'NE'`, `toUsStateCode(' nebraska ') === 'NE'`, `toUsStateCode('Massachusetts') === 'MA'`, `toUsStateCode('district of columbia') === 'DC'`, `toUsStateCode('PR') === null`, `toUsStateCode('Nebr') === null`. Task 7's `normalizeState` delegates to it. Not an `as const` array, so it adds no banned copy words.
- **Field rules and messages** (`BrandInfoSchema`, a `z.object` over every `BRAND_FIELDS` key; each issue's `path` is `[field]`; strings are trimmed first):
  - `legalName`: 2–120 characters → "Enter the legal name on your IRS paperwork."
  - `ein`: `/^\d{2}-?\d{7}$/`, normalized to `12-3456789` → "Enter your 9-digit EIN, like 12-3456789."
  - `businessType`: one of `BUSINESS_TYPES` → "Pick your business type."
  - `street` ≤ 120 and `city` ≤ 60, non-empty → "Enter your business address." (each on its own path)
  - `state`: through `toUsStateCode`, so `ne` → `NE`; a name such as `Nebraska` is **refused** here (the form takes the 2-letter code) → "Please use the 2-letter state, like NE." Implement as: trimmed value must be 2 letters and `toUsStateCode` non-null.
  - `zip`: 5 digits → "Please enter a ZIP code, like 68102."
  - `website`: http(s) URL; a bare `acme.com` becomes `https://acme.com` → "Enter your website, like https://acme.com."
  - `contactFirstName`, `contactLastName`, `contactTitle`: 1–60 characters → "Please fill this in."
  - `contactEmail`: an email address → "Please enter a valid email address."
  - `contactPhone`: through `toE164` (stored as E.164) → "That doesn't look like a US phone number."
- **Campaign text,** with `N` the company name (exact strings):
  - `description`: `${N} texts its roofing customers about appointments, estimates and job updates, and sends storm check-ins offering free roof inspections.`
  - `messageFlow`: `Customers give ${N} their mobile number by phone, in person or on a web form, and agree to receive texts. Customers imported from ${N}'s records were confirmed by the business owner to have agreed. Privacy policy: ${privacyUrl}. Terms: ${termsUrl}.`
  - `samples`:
    1. `Hi Maria, it's ${N}. Your roof inspection is confirmed for Tuesday at 10:00 AM. Reply STOP to opt out.`
    2. `Hi Maria, it's ${N}. Tuesday's hail hit your street. Want a free roof check this week? Reply YES to book. Reply STOP to opt out.`
  - `optInMessage`: `${N}: You're signed up for texts about your roof and storm check-ins. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`
  - `optOutMessage`: `You're unsubscribed from ${N} texts. No more messages will be sent. Reply START to resubscribe.`
  - `helpMessage`: `${N}: for help call ${companyPhone ? displayUsPhone(companyPhone) : 'us'}. Msg & data rates may apply. Reply STOP to opt out.`
  - `useCase: 'MIXED'`, `hasEmbeddedLinks: true`, `hasEmbeddedPhone: true`, `privacyUrl`/`termsUrl` passed through.
- **`plainRejection`,** first match in this order (null → the fallback):
  1. `/\b(ein|tax|irs|tin)\b/i` → `['legalName','ein']`, "The phone carriers couldn't match your legal name and EIN with IRS records. Use the exact name on your IRS EIN letter."
  2. `/website|url|privacy|domain/i` → `['website']`, "The phone carriers couldn't check your website. It needs to show your business name and a privacy policy (you can use the Roofline page)."
  3. `/address/i` → `['street','city','state','zip']`, "The phone carriers couldn't confirm your business address. Use the address on your tax records."
  4. `/email/i` → `['contactEmail']`, "Use an email address at your business's own website if you have one."
  5. `/phone/i` → `['contactPhone']`, "Check the contact phone number."
  6. `/opt.?in|consent|sample|message flow/i` → `[]`, "The phone carriers asked for clearer details on how customers agree to texts. We've updated them, so send it again."
  7. Anything else → `[]`, "The phone carriers turned this down. Check your details and send it again."

**Tests:**
- `texting.test.ts`:
  - Schema: a full valid brand parses, and `ein '123456789'` becomes `'12-3456789'`; `ein '12-34'` → an issue with path `['ein']` and the EIN message; `website 'acme.com'` → `'https://acme.com'`; `state 'Nebraska'` → the state message; `state 'ne'` → `'NE'`; `contactPhone '(402) 555-0144'` → `'+14025550144'`; `businessType 'sole_prop'` → "Pick your business type."
  - `buildCampaign({ companyName: 'Acme Roofing', companyPhone: '+14025550199', privacyUrl: 'P', termsUrl: 'T' })`: `samples[1]` equals `Hi Maria, it's Acme Roofing. Tuesday's hail hit your street. Want a free roof check this week? Reply YES to book. Reply STOP to opt out.`; `helpMessage` contains `(402) 555-0199`; `useCase === 'MIXED'`; `messageFlow` ends `Privacy policy: P. Terms: T.`. With `companyPhone: null` → `helpMessage` contains `for help call us.`
  - `plainRejection`: `'EIN does not match IRS'` → fields `['legalName','ein']`; `'Website not accessible'` → `['website']`; `null` → the fallback with `[]`; `'Tax ID and website'` → the EIN rule (first match wins); `'Opt-in flow unclear'` → rule 6.
- `address.test.ts` (extend): the `toUsStateCode` cases above; `Object.keys(US_STATE_NAMES).length === 51`.

**Verify notes:**
- `npx vitest run --project @roofline/shared` (no database), `npm run typecheck && npm run lint`.
- New `as const` arrays add banned copy words (`non_profit`, `not_started`, `needs_fix`): run `npx vitest run --project @roofline/web copy-rules` (expected unaffected; F3 web copy must avoid them).
- Commit: `feat(shared): texting registration fields, campaign text and plain rejection reasons`.

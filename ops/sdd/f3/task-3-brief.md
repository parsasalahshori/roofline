### Task 3: Shared billing config and metering math

**Base:** `f3-setup` after F3 Task 1 is merged (or stacked on `f3-t1`). Needs only Task 1's placeholder `packages/shared/src/billing.ts` (`export {};`, already in the shared barrel) and `USAGE_KINDS` / `UsageKind` in `packages/db/src/schema/enums.ts`. No F2 dependency.

**Split:**
- Builder 1: the zod schema and loader in `billing.ts` (`BillingConfigError`, `parseBillingConfig`, `planByKey`, the types, `PlanSummary`, `BillingView`).
- Builder 2: the metering and amount functions in `billing.ts` (`USAGE_KINDS`, `METERS`, `INVOICE_KINDS`, `METER_EVENT_NAME`, `priceLookupKeys`, `planFromLookupKey`, `meteredTiers`, `meterUnits`, `invoiceAmountCents`). Builders 1 and 2 share `billing.ts`: Builder 2 writes the top half (constants + math), Builder 1 the bottom half (config + views); the lead joins them.
- Builder 3: `config/billing-plans.example.json`, the `USAGE_KINDS` move in `packages/db/src/schema/enums.ts`, and `packages/shared/test/billing.test.ts`.

**Files:**
- Create: `config/billing-plans.example.json` (repo root `config/` is new), `packages/shared/test/billing.test.ts`
- Modify: `packages/shared/src/billing.ts` (replace the placeholder), `packages/db/src/schema/enums.ts`
- Do not touch: `packages/shared/src/index.ts` (Task 1 already has `export * from './billing.ts'`), `package-lock.json`.

**Interfaces:**
- **Config types**, keys exactly as spec §5.2:
```ts
export const USAGE_KINDS = ['ai_call_minute','sms_segment','mms','exact_report','texting_registration_fee','phone_number_month'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];
export const METERS = ['ai_call_minute', 'sms_segment'] as const;           export type Meter = (typeof METERS)[number];
export const INVOICE_KINDS = ['exact_report', 'texting_registration_fee', 'phone_number_month'] as const;
export const METER_EVENT_NAME: Record<Meter, string> = { ai_call_minute: 'roofline_ai_call_minute', sms_segment: 'roofline_sms_segment' };
export type PlanConfig = { key: string; name: string; monthly_price_cents: number;
  included: { ai_call_minutes: number; sms_segments: number }; overage_cents: { ai_call_minute: number; sms_segment: number } };
export type BillingConfig = { plans: PlanConfig[]; exact_report_markup_pct: number;
  pass_through_cents: { brand_registration: number; campaign_vetting: number; campaign_monthly: number; phone_number_monthly: number } };
export class BillingConfigError extends Error {}
export function parseBillingConfig(json: unknown): BillingConfig;     // zod; issues listed as "path: problem"
export function planByKey(config: BillingConfig, key: string): PlanConfig | null;
export function priceLookupKeys(planKey: string): { monthly: string; ai_call_minute: string; sms_segment: string };
export function planFromLookupKey(lookupKey: string): string | null;
export function meteredTiers(plan: PlanConfig, meter: Meter): { up_to: number | 'inf'; unit_amount_decimal: string }[];
export function meterUnits(kind: UsageKind, quantity: number): { meter: Meter; value: number } | null;
export function invoiceAmountCents(kind: UsageKind, quantity: number, unitCostCents: number, config: BillingConfig): number;
```
- **Views:**
```ts
export type PlanSummary = { key: string; name: string; monthlyPriceCents: number;
  included: { aiCallMinutes: number; smsSegments: number }; overageCents: { aiCallMinute: number; smsSegment: number } };
export type BillingView = { status: CompanyStatus; planKey: string | null; planName: string | null; trialEndsAt: string | null;
  hasPaymentMethod: boolean; canOpenPortal: boolean; periodStart: string;
  usage: { meter: Meter; used: number; included: number | null }[]; plans: PlanSummary[] };
```
  `CompanyStatus` comes from `./enums.ts` in shared.
- **Rules:**
  - Plan keys match `/^[a-z][a-z0-9]{1,30}$/` and are unique (a duplicate is an issue at `plans.<i>.key`).
  - Every amount is a whole number ≥ 0 (`z.number().int().nonnegative()`).
  - `exact_report_markup_pct` is 0–500.
  - An optional top-level `_note` string is allowed; any other unknown key is an issue (`.strict()`).
  - `BillingConfigError.message` lists every issue as `<dotted path>: <problem>`, one per line, e.g. `plans.0.monthly_price_cents: Too small: expected number to be >=0`. Tests match only the path.
- **Lookup keys:** `roofline_<key>_monthly`, `roofline_<key>_ai_call_minute`, `roofline_<key>_sms_segment`. `planFromLookupKey` returns `<key>` for any of the three shapes, else null.
- **`meteredTiers`:** normally `[{ up_to: included, unit_amount_decimal: '0' }, { up_to: 'inf', unit_amount_decimal: String(overage) }]`; when the included amount is 0, only the second tier. `included` is `plan.included.ai_call_minutes` / `.sms_segments`, `overage` is `plan.overage_cents.ai_call_minute` / `.sms_segment`.
- **`meterUnits`:** `sms_segment` → `{sms_segment, ceil(q)}`; `mms` → `{sms_segment, 3 × ceil(q)}`; `ai_call_minute` → `{ai_call_minute, ceil(q)}`; any other kind → null.
- **`invoiceAmountCents`:** `exact_report` → `Math.round(q × unit × (100 + markup) / 100)`; the other invoice kinds → `Math.round(q × unit)`; a metered kind (`ai_call_minute`, `sms_segment`, `mms`) → `throw new RangeError(...)`.
- **The `USAGE_KINDS` move:** `packages/db/src/schema/enums.ts` drops its own `USAGE_KINDS`/`UsageKind` and adds them to its existing re-export block: `export { …, USAGE_KINDS, type UsageKind } from '@roofline/shared';`. `packages/db/src/repos/usage.ts` (Task 1, `recordUsage`) keeps importing `UsageKind` from wherever it does today and must still typecheck. The array values and order are unchanged, so the migration and CHECK are unchanged.
- **Example file** — the JSON below, verbatim (pretty-printing allowed, values not):
```json
{ "_note": "Example values for development and tests only. The owner sets real prices in the file BILLING_PLANS_FILE points to.",
  "plans": [
    { "key": "starter", "name": "Starter", "monthly_price_cents": 19900,
      "included": { "ai_call_minutes": 300, "sms_segments": 1000 }, "overage_cents": { "ai_call_minute": 25, "sms_segment": 3 } },
    { "key": "pro", "name": "Pro", "monthly_price_cents": 39900,
      "included": { "ai_call_minutes": 1000, "sms_segments": 5000 }, "overage_cents": { "ai_call_minute": 20, "sms_segment": 2 } } ],
  "exact_report_markup_pct": 20,
  "pass_through_cents": { "brand_registration": 4400, "campaign_vetting": 1500, "campaign_monthly": 1000, "phone_number_monthly": 115 } }
```

**Tests (`packages/shared/test/billing.test.ts`)** — `EXAMPLE = fileURLToPath(new URL('../../../config/billing-plans.example.json', import.meta.url))`:
```ts
const cfg = parseBillingConfig(JSON.parse(readFileSync(EXAMPLE, 'utf8')));
expect(cfg.plans.map((p) => p.key)).toEqual(['starter', 'pro']);
expect(meterUnits('mms', 1)).toEqual({ meter: 'sms_segment', value: 3 });
expect(meterUnits('sms_segment', 2)).toEqual({ meter: 'sms_segment', value: 2 });
expect(meterUnits('ai_call_minute', 2.2)).toEqual({ meter: 'ai_call_minute', value: 3 });
expect(meterUnits('exact_report', 1)).toBeNull();
expect(invoiceAmountCents('exact_report', 1, 4500, cfg)).toBe(5400);
expect(invoiceAmountCents('texting_registration_fee', 1, 4400, cfg)).toBe(4400);
expect(invoiceAmountCents('phone_number_month', 1, 115, cfg)).toBe(115);
expect(() => invoiceAmountCents('sms_segment', 1, 1, cfg)).toThrow(RangeError);
expect(meteredTiers(planByKey(cfg, 'starter')!, 'sms_segment')).toEqual([{ up_to: 1000, unit_amount_decimal: '0' }, { up_to: 'inf', unit_amount_decimal: '3' }]);
expect(priceLookupKeys('pro').monthly).toBe('roofline_pro_monthly');
expect(planFromLookupKey('roofline_pro_sms_segment')).toBe('pro');
```
- Also: `meteredTiers` with `included.sms_segments: 0` → one tier `{ up_to: 'inf', unit_amount_decimal: '3' }`; `planByKey(cfg, 'nope')` → null; `planFromLookupKey('other_pro_monthly')` → null.
- `it('refuses bad config with the path')`: a duplicate key (`plans.1.key`), `monthly_price_cents: -1` (`plans.0.monthly_price_cents`) and a missing `included` (`plans.0.included`) each throw `BillingConfigError` whose message contains that path.
- `it('the code has no hard-coded prices')`: walk `apps/*/src/**` and `packages/*/src/**` (skip `node_modules`); no file contains `19900` or `39900`.

**Verify notes:**
- `npx vitest run --project @roofline/shared` (no database) and `npm run typecheck && npm run lint`.
- `USAGE_KINDS` now exported from `@roofline/shared` makes its snake_case values banned words in web copy: run `npx vitest run --project @roofline/web copy-rules` too (expected unaffected).
- The plan's `npx vitest run --project @roofline/db` step needs Docker: leave it to CI (`ci-check`).
- Commit: `feat(shared): billing plan config, meters and invoice amounts`.

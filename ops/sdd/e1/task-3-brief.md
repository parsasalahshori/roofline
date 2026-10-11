### Task 3: Shared tiers and financing

**Base:** `e1-estimator` after Task 1 is merged. From F1 `packages/shared/src/pricing.ts` (real): `Scope`, `Pricebook`, `calculateQuote`, `Calculation`, `QuoteLine`, `defaultScope`. From T1: `TIERS`, `ADD_ON_UNITS` in `proposals.ts`.

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 `TierTemplate` schema and `DEFAULT_TIER_TEMPLATES`; Builder 2 `priceTier` and `addOnQuantity`; Builder 3 `monthlyPaymentCents` and the tests.

**Files:** Modify `packages/shared/src/tiers.ts`; Test `packages/shared/test/tiers.test.ts`.

**Interfaces:**
```ts
export type AddOn = { name: string; unit: AddOnUnit; rateCents: number; taxable: boolean };
export type TierTemplate = { tier: Tier; name: string; material: Scope['material']; wastePercent: number; markupPercent: number | null; addOns: AddOn[]; highlights: string[]; enabled: boolean };
export const TierTemplateSchema: z.ZodType<TierTemplate>;       // name 1–60; ≤ 8 add-ons; rate 0–1,000,000 cents; ≤ 4 highlights of ≤ 60 chars
export const DEFAULT_TIER_TEMPLATES: readonly TierTemplate[];   // spec Decision 10, exact names, rates and highlights
export type MeasuredQuantities = { squares: number; edgeFt: number; ridgeFt: number; valleyFt: number };
export function addOnQuantity(unit: AddOnUnit, q: MeasuredQuantities): number;   // per_square → squares (× (1 + waste)) ; per_edge_ft → edgeFt ; per_ridge_ft → ridgeFt ; per_valley_ft → valleyFt ; per_job → 1
export type TierPrice = { scope: Scope; calculation: Calculation; addOnLines: QuoteLine[]; totalCents: number };
export function priceTier(t: TierTemplate, base: Omit<Scope, 'material' | 'wastePercent' | 'markupPercent'> & { markupPercent: number }, prices: Pricebook, q: MeasuredQuantities): TierPrice;
export function monthlyPaymentCents(principalCents: number, aprBps: number, months: number): number;   // amortized, rounded up to the cent; aprBps 0 → ceil(P/n)
```
- **`priceTier`:** `calculateQuote({ ...base, material: t.material, wastePercent: t.wastePercent, markupPercent: t.markupPercent ?? base.markupPercent }, prices)`, then add-on lines `{ code: 'addon:<n>', name, quantity, unit, unitCents, totalCents, taxable }`; `totalCents = calc.totalCents + Σ addOn.totalCents × (1 + markup) + tax on taxable add-ons` — implemented by recomputing subtotal, markup and tax over **all** lines with v1's rounding rules (write it as `withAddOns(calc, lines, markupPercent, taxPercent)` and test it equals `calculateQuote` when there are no add-ons).

**Tests:**
- the three defaults parse; Good on v1's default scope equals `calculateQuote` exactly; Better adds the two add-on lines with the expected quantities; taxable add-ons are taxed, non-taxable not; `monthlyPaymentCents(1_425_000, 999, 120)` = the amortization value (compute in the test with the formula, assert equality); 0% APR; invalid templates refused with paths.

**Carries and rulings:**
- F3 T3's scan: no `src` file may contain `19900` or `39900` — check `DEFAULT_TIER_TEMPLATES` rates.

**Verify notes:**
- `npx vitest run --project @roofline/shared tiers`.
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(shared): Good/Better/Best templates, add-ons and the financing estimate`

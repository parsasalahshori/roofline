### Task 4: Shared storm logic

**Base:** `s1-storm` after Task 1 is merged. Pure. Real: `renderBody` (`packages/shared/src/render.ts`), `localDate` (`time-zone.ts`).

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 templates and rendering; Builder 2 yes-words, budgets, circle radius math, labels; Builder 3 tests.

**Files:** Modify `packages/shared/src/storm.ts`; Test `packages/shared/test/storm.test.ts`.

**Interfaces:**
```ts
export const DEFAULT_STORM_SMS = 'Hi {first_name}, it\'s {company}. Radar shows hail up to {hail_size} hit near your home on {street} {day}. Want a free roof check this week? Reply YES to book. Reply STOP to opt out.';
export const DEFAULT_STORM_EMAIL_SUBJECT = 'Hail near your home on {street}';
export const DEFAULT_STORM_EMAIL_BODY: string;   // plain text; must include {company}, {company_address}, {unsubscribe}
export type StormFields = { first_name: string; company: string; hail_size: string; street: string; day: string; company_address?: string; unsubscribe?: string };
export function renderStormTemplate(tpl: string, f: StormFields): string;           // unknown tokens left as-is → the gate's content rule catches them
export function missingStormTokens(tpl: string, channel: 'sms' | 'email'): string[]; // sms needs {company} + "Reply STOP"; email needs {company},{company_address},{unsubscribe}
export function hailLabel(inches: number): string;          // 1.75 → '1.75"'; 1 → '1"'
export function stormDayLabel(convectiveDay: string, now: Date, tz: string): string; // 'today' | 'yesterday' | 'on Tuesday'
export function isYesReply(body: string): boolean;          // yes, y, yeah, yep, sure, ok, okay, please, book, 👍 — whole-message, case/punct-insensitive; 'yes stop' → false
export function splitAdBudget(totalCents: number, googleSharePct: number): { google: number; meta: number };
export function dailyBudgetCents(maxCents: number, days: number): number;          // floor; daily × days ≤ max
export function nextCircleRadiusM(prevM: number): number;                           // ×2; first 1000 (Google min); Meta min 1609
export function hexCenterSpacingM(radiusM: number): number;                         // radius × √3 so circles cover the hex grid
export function stormTitle(placeName: string | null, maxIn: number): string;       // 'Storm plan for hail near Omaha, NE (up to 1.75")'
```

**Tests:**
- rendering and missing tokens; `isYesReply` table (20 cases); budget split sums to total; `dailyBudgetCents(27000, 7) * 7 <= 27000`; day labels across a midnight in the company time zone.

**Carries and rulings:**
- Pure; templates are server/shared text, not UI copy.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(shared): storm templates, yes replies, ad budgets and hail labels`

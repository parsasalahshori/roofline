### Task 3: Shared tool schemas and forwarding codes

**Base:** `d1-front-desk` after Task 1 is merged. zod 4 (shared). Pure.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 tool zod schemas + JSON Schema export (strict-compatible: `additionalProperties: false`, all properties `required`, nullable instead of optional); Builder 2 `forwarding.ts`; Builder 3 tests.

**Files:** Modify `packages/shared/src/{front-desk-tools,forwarding}.ts`; Test `packages/shared/test/{front-desk-tools,forwarding}.test.ts`.

**Interfaces:**
```ts
export const FRONT_DESK_TOOLS = {
  lookup_my_jobs:        { input: z.object({}).strict() },
  verify_caller:         { input: z.object({ name: z.string().min(2).max(80), street: z.string().min(2).max(80) }).strict() },
  check_forecast:        { input: z.object({ date: IsoDate, propertyId: z.string().uuid().nullable() }).strict() },
  hail_at_my_home:       { input: z.object({ propertyId: z.string().uuid().nullable() }).strict() },
  find_inspection_times: { input: z.object({ propertyId: z.string().uuid().nullable(), address: z.string().max(200).nullable(), fromDate: IsoDate.nullable(), partOfDay: z.enum(['any','morning','afternoon']) }).strict() },
  book_inspection:       { input: z.object({ slotStart: z.string().datetime(), slotUserId: z.string().uuid(), propertyId: z.string().uuid().nullable(), address: z.string().max(200).nullable(), firstName: z.string().max(60), lastName: z.string().max(60), notes: z.string().max(500) }).strict() },
  confirm_appointment:   { input: z.object({ appointmentId: z.string().uuid() }).strict() },
  move_inspection:       { input: z.object({ appointmentId: z.string().uuid(), slotStart: z.string().datetime(), slotUserId: z.string().uuid() }).strict() },
  cancel_inspection:     { input: z.object({ appointmentId: z.string().uuid(), reason: z.string().max(200) }).strict() },
  take_claim_details:    { input: z.object({ jobId: z.string().uuid().nullable(), insurer: z.string().max(80), claimNumber: z.string().max(40).nullable(), dateOfLoss: IsoDate.nullable(), description: z.string().max(1000), adjusterVisitAt: z.string().datetime().nullable() }).strict() },
  take_message:          { input: z.object({ reason: z.string().max(500), urgent: z.boolean(), callbackWhen: z.string().max(100).nullable(), name: z.string().max(80).nullable() }).strict() },
  transfer_to_person:    { input: z.object({ reason: z.enum(['asked','leak','danger','angry','trade_caller','not_understood']), summary: z.string().max(200) }).strict() },
  end_call:              { input: z.object({ reason: z.enum(['goodbye','spam','silence']) }).strict() },
} as const;
export type FrontDeskToolName = keyof typeof FRONT_DESK_TOOLS;
export const TOOL_DESCRIPTIONS: Record<FrontDeskToolName, string>;      // plain-English descriptions used in the API tool list (stable text: part of the cached prefix)
export function toolJsonSchemas(): { name: FrontDeskToolName; description: string; input_schema: object }[];   // deterministic order (alphabetical) for cache stability
export const TEXT_CHANNEL_TOOLS: readonly FrontDeskToolName[];          // all but transfer_to_person and end_call
// forwarding.ts
export const CARRIERS = ['verizon','att','tmobile','other_gsm','landline','ringcentral','google_voice','ooma','spectrum','comcast','grasshopper','other'] as const;
export function forwardingSteps(carrier: Carrier, mode: 'all' | 'no_answer', roofline: string /* E.164 */): { kind: 'dial' | 'steps'; on: string[]; off: string[] };   // spec §12 codes, number as 10 digits
```

**Tests:**
- every schema converts to a strict JSON Schema (no optional keys, `additionalProperties: false`); order is stable; forwarding codes per carrier and mode; E.164 → 10 digits.

**Carries and rulings:**
- Tool schemas must convert to strict JSON Schema (no optional keys; nullable instead).

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(shared): Front Desk tool schemas and call-forwarding codes`

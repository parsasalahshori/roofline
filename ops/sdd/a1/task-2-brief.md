### Task 2: Shared baselines, metrics and rule sentences

**Base:** `a1-agents` after Task 1 is merged. Real (F1/F3): `packages/shared/src/steps.ts` (`StepTypeDef.minutesSaved(payload, result)` per type; `send_sms_batch` = `min(120, 1.5 × sent)`). Step types to convert: F1/F3 `demo_*`, `send_sms_batch`; **[E1]** `send_proposal`, `order_exact_report`; **[S1]** `send_email_batch`, `build_routes`, `create_ad_campaign`; **[D1]** none (D1 has no R2 steps, plan Ruling 3).

Read first: `ops/sdd/a1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** Builder 1 `agents.ts` baselines and `minutesFor`; Builder 2 `steps.ts` refactor (each step type's `minutesSaved` replaced by `baseline` + `units(payload, result)`; new `front_desk_call`/`front_desk_texts` types, `internal`, not user-creatable); Builder 3 metrics helpers, rule sentence builders, tests.

**Interfaces:**
```ts
export const TIME_BASELINES = { text_sent: { minutes: 1.5, capMinutes: 120, unit: 'text', basis: '…' }, email_sent: …, route_built: …, ad_campaign: …, proposal_sent: …, exact_report: …, call_answered: { minutes: 2, perCallLength: true }, spam_call: { minutes: 0, perCallLength: true }, booking: …, text_reply: … } as const;   // spec §3.1
export type BaselineKey = keyof typeof TIME_BASELINES;   // G1 extends the object in its own task
export function minutesFor(key: BaselineKey, units: number, overrides: Partial<Record<BaselineKey, number>>, extra?: { callMinutes?: number }): { minutesPerUnit: number; minutes: number };
export function successRate(i: { done: number; partlyDone: number; ran: number }): number | null;   // null under 5
export function hoursLabel(minutes: number): string;   // 'about 31 hours' / 'about 4.5 hours'
export function moneyLabel(minutes: number, hourlyRateCents: number): string;   // '≈ $870'
export type RuleSentence = { text: string; links: { label: string; href: string }[] };
export function rulesFor(agent: Agent, s: AgentRuleFacts): RuleSentence[];   // spec §6 examples; facts gathered by the API
```

**Tests:**
- table defaults; caps; overrides; units from results (sent counts only); every step type has a baseline; labels; success rate edge cases; rule sentences for each launch agent.

**Carries and rulings:**
- **Ruling AX-A:** keep `StepTypeDef.minutesSaved` as a compatibility function derived from `baseline` + `units` with default minutes until Task 3 switches `tasks/service.ts` to snapshots; Task 3 then removes the field. Typecheck stays green between merges.
- **Ruling AX-B:** `G1_AGENTS_SHIPPED = false` lives in `shared/agents.ts`; G1 T15 flips it.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(shared): time-saved baselines, success rate and plain-English agent rules`

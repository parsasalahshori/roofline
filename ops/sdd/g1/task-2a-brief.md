### Task 2a: Shared follow-up limits, due rules, weather risk, claim status flow (Ruling GX-I)

**Base:** stacked on `g1-t1` 15f674b (Task 1 creates `packages/shared/src/more-agents.ts` with `CLAIM_STATUSES`, `CLAIM_EVENT_ACTORS`, `FOLLOW_UP_KINDS`). Pure TypeScript in `packages/shared` only: no db, no api, no `steps.ts`, no guards (those are Task 2b, after A1 T2 and D1 T2).

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md` §3.3, §4, §5 (Decisions 7, 8).

**Split:**
- Builder 1: `followUpAllowed` and the three `…Due` rules (append to `packages/shared/src/more-agents.ts`, top half).
- Builder 2: `HourlyForecast`, `weatherRisk`, `CLAIM_STATUS_FLOW`, `canMoveClaim` (bottom half; the lead joins).
- Builder 3: `packages/shared/test/more-agents.test.ts`.

**Files:** Modify `packages/shared/src/more-agents.ts` (append; keep Task 1's constants). Test `packages/shared/test/more-agents.test.ts`. Do not touch the shared barrel (more-agents.ts is already exported), `steps.ts`, `agents.ts`.

**Interfaces** (all pure; dates are `Date`; "days" are 24-hour periods measured from `now`):
```ts
export type FollowUpLogEntry = { customerId: string; jobId: string | null; kind: FollowUpKind; n: number; at: Date };
export const FOLLOW_UP_SPACING_DAYS = 3;   // Decision 8: one Follow-up text per customer per 3 days, across Follow-up kinds
export const STORM_QUIET_DAYS = 3;         // Decision 8: nothing to a customer with a Storm Scout text in the last 3 days
export const REPLY_STOP_DAYS = 3;          // Decision 7: any inbound text on the customer in the last 3 days stops follow-ups
export const CLAIMS_SPACING_DAYS = 4;      // §3.3: max one claims text per customer per 4 days
export const CLAIMS_MAX_PER_CLAIM = 4;     // §3.3: max 4 per claim (counted per job)
export type FollowUpCheck = { log: readonly FollowUpLogEntry[]; kind: FollowUpKind; customerId: string; jobId: string | null;
  now: Date; lastInboundAt: Date | null; lastStormTextAt: Date | null };
export type FollowUpDecision = { allowed: true } | { allowed: false; reason: 'replied' | 'storm_text' | 'spacing' | 'claims_spacing' | 'claims_max' };
export function followUpAllowed(c: FollowUpCheck): FollowUpDecision;
```
- `reminder` and `no_show` skip every check (see below). For the other kinds, order of checks, first failing wins: `replied` (lastInboundAt within REPLY_STOP_DAYS), `storm_text` (lastStormTextAt within STORM_QUIET_DAYS), then by kind:
  - `proposal`, `lead`, `review`: `spacing` when the log has any entry of kind proposal|lead|review for the customer within FOLLOW_UP_SPACING_DAYS.
  - `claims`: `claims_spacing` when any `claims` entry for the customer within CLAIMS_SPACING_DAYS; `claims_max` when the job already has CLAIMS_MAX_PER_CLAIM `claims` entries.
  - `reminder`, `no_show`: for `reminder` and `no_show` return `{ allowed: true }` without any check (they are appointment logistics, not nudges).
- Boundaries: "within N days" means `now - at < N * 24h` (exactly N days ago is allowed again).

```ts
export type ProposalFacts = { sentAt: Date; lastViewedAt: Date | null; signedAt: Date | null; textsSent: number; lastTextAt: Date | null };
export function proposalFollowUpDue(p: ProposalFacts, now: Date, days: readonly number[] /* company followup_days, default [3,4] */): 'text' | 'call_rep' | null;
```
- Signed → null. First text: due when `textsSent === 0` and (`now - sentAt >= days[0]` days, or `lastViewedAt` and `now - lastViewedAt >= 2` days). Second: `textsSent === 1` and `now - lastTextAt >= days[1]` days. After two texts (`textsSent >= 2`) and `now - lastTextAt >= days[1]` days → `'call_rep'` (once the caller records it, it stops asking). Otherwise null.
```ts
export type LeadFacts = { createdAt: Date; hasAppointment: boolean; textsSent: number; lost: boolean };
export function leadFollowUpDue(l: LeadFacts, now: Date, leadDays: number /* default 2 */): boolean;   // !lost && !hasAppointment && textsSent === 0 && now - createdAt >= leadDays days
export type ClaimFacts = { status: ClaimStatus; inspectedAt: Date | null; statusChangedAt: Date; adjusterAt: Date | null };
export type ClaimNudge = 'ask_filed' | 'ask_adjuster_date' | 'ask_adjuster_outcome';
export function claimNudgeDue(c: ClaimFacts, now: Date, days: readonly number[] /* claims_nudge_days, default [3,5,7] */): ClaimNudge | null;
```
- `not_filed` and `inspectedAt` set and `now - inspectedAt >= days[0]` → `ask_filed`; `filed` and no `adjusterAt` and `now - statusChangedAt >= days[1]` → `ask_adjuster_date`; `adjuster_scheduled` and `adjusterAt` and `now - adjusterAt >= days[2]` → `ask_adjuster_outcome`; else null.
```ts
export type HourlyForecast = { at: string /* ISO instant */; precipPct: number /* 0-100 */; gustMph: number | null };
export type WorkHours = { start: number; end: number };   // local hours, 0-23, end exclusive (e.g. 7 and 18)
export type WeatherThresholds = { rainPct: number; gustMph: number };   // company weather_rain_pct (60), weather_gust_mph (25)
export type WeatherRisk = { risky: boolean; reasons: ('rain' | 'wind')[]; worstPrecipPct: number; worstGustMph: number | null };
export function weatherRisk(hourly: readonly HourlyForecast[], workHours: WorkHours, thresholds: WeatherThresholds, timeZone: string): WeatherRisk;
```
- Only hours whose local hour (in `timeZone`, via `Intl.DateTimeFormat`) is in `[start, end)` count. Rain when `precipPct >= rainPct`; wind when `gustMph !== null && gustMph >= gustMph threshold` (null gust is never wind risk). `reasons` in the order rain, wind, no duplicates. An empty list → not risky.
```ts
export const CLAIM_STATUS_FLOW: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>>;
export function canMoveClaim(from: ClaimStatus, to: ClaimStatus): boolean;   // to ∈ CLAIM_STATUS_FLOW[from] (same status → false)
```
- Flow: `not_filed → filed, closed`; `filed → adjuster_scheduled, approved, partly_approved, denied, closed`; `adjuster_scheduled → inspected, approved, partly_approved, denied, closed`; `inspected → approved, partly_approved, denied, supplement_requested, closed`; `approved → supplement_requested, closed`; `partly_approved → supplement_requested, approved, closed`; `denied → supplement_requested, closed`; `supplement_requested → approved, partly_approved, denied, closed`; `closed → (none)`. People may set any status in the job window (Task 6 decides); the flow is what the agent may do from a reply.

**Tests (`more-agents.test.ts`):** each rule's boundaries (exactly N days allowed, N days − 1 minute blocked); `followUpAllowed` check order (a reply beats spacing), cross-kind spacing (a lead text 2 days ago blocks a proposal text), claims spacing vs max, reminders always allowed; `proposalFollowUpDue` first/second/`call_rep`/signed and the 2-days-after-view path; `leadFollowUpDue`; `claimNudgeDue` all three kinds and nothing for other statuses; `weatherRisk` with a forecast across midnight in `America/Chicago` (only work hours count), null gusts, both reasons; every `CLAIM_STATUSES` value has a `CLAIM_STATUS_FLOW` entry and `closed` has none.

**Verify:** `npx vitest run --project @roofline/shared more-agents` and `npm run typecheck && npm run lint` (through `ops/bin/slot`); `ci-check`.
- Commit: `feat(shared): G1 follow-up limits, due rules, weather risk and claim flow (G1 Task 2a)`

### Task 3: API skeleton — agent jobs and schedules, drafting/extraction seams, step handler stubs, inbound order

**Base:** branch `g1-t3` = `g1-agents` 4e4dc3c (G1 T1, T2a, T2b, T9; D1 T1–T3; A1 T1–T2; C1 T5 via A1) plus a merge of `origin/d1-t4` b548ebc (D1 Task 4: the `Llm` seam in `apps/api/src/providers/llm.ts` — `interface Llm { configured; route; answer; summarize }`, `LlmUnavailableError` —, `ScriptedLlm` in `providers/fakes/scripted-llm.ts`, `providers/anthropic/*`, `deps.llm`), Ruling AZ. Do not edit D1's existing methods; add to them.

Read first: `ops/sdd/g1/global-constraints.md`, `ops/sdd/g1/progress.md` (Rulings GX-A, GX-D, GX-N), spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md` §2–§5; then `apps/api/src/jobs/{queue,worker,handlers}.ts`, `apps/api/src/tasks/handlers.ts` (`builtInHandlers`), `apps/api/src/hooks/twilio.ts`, `apps/api/src/providers/{llm.ts,fakes/scripted-llm.ts,anthropic/}`, `apps/api/src/config.ts`, `apps/api/test/helpers.ts` (`makeTestApp`, `TestApp`).

**Split:**
- Builder 1 — jobs and step handler stubs: `apps/api/src/agents/schedule.ts` (new), `apps/api/src/jobs/worker.ts` (SCHEDULES), `apps/api/src/jobs/queue.ts` + `jobs/handlers.ts` (JOB_NAMES/handlers), `apps/api/src/tasks/handlers.ts` (four stubs), the five agent entry stubs, `apps/api/test/g1-schedule.test.ts`, and the job/schedule list tests (`test/jobs.test.ts`, `test/pgboss.test.ts`).
- Builder 2 — seams: `apps/api/src/providers/llm.ts` (types + two methods), `providers/fakes/scripted-llm.ts`, `providers/anthropic/*` (stubs that throw `LlmUnavailableError`; Task 4 implements them), `apps/api/src/config.ts` (`MAPTILER_SERVER_KEY`), `apps/api/test/g1-llm-seam.test.ts`.
- Builder 3 — inbound order: `apps/api/src/hooks/twilio.ts` (one `// G1 Agents` block), `apps/api/src/agents/claims/replies.ts` (stub), `apps/api/test/g1-inbound-order.test.ts`.

**1. Per-company local-hour schedules (`agents/schedule.ts`)**
```ts
export type AgentJob = 'claims-daily' | 'scheduler-reminders' | 'scheduler-agenda' | 'scheduler-weather' | 'followup-daily';
/** The company-local hours each job runs at; reminders read company_settings.reminder_hour (default 15). */
export const AGENT_JOB_HOURS: Record<Exclude<AgentJob, 'scheduler-reminders'>, readonly number[]> =
  { 'claims-daily': [10], 'scheduler-agenda': [18], 'scheduler-weather': [6, 14], 'followup-daily': [9] };
export function dueNow(job: AgentJob, now: Date, timeZone: string, reminderHour: number): boolean;   // true when local time is in [hh:00, hh:15) for one of the job's hours
```
- One SCHEDULES entry per job, cron `*/15 * * * *`, whose `run(deps, now)` lists active companies (an existing system query: companies not canceled, with their `timezone` and `company_settings.reminder_hour`; add one small `@roofline/db/system` function if none exists) and, for each company where `dueNow` is true, `deps.jobs.send(<job>, { companyId }, { singletonKey: `${job}:${companyId}:${localDate}` })` so a fire is at most once per company per local day and hour slot (use `${localDate}T${hh}` in the key for the twice-daily weather job).
- The five job names join `JOB_NAMES` under a `// G1 Agents` comment after D1's block; their handlers in `jobs/handlers.ts` call stub entry points that do nothing yet: `agents/claims/nudges.ts` `runClaimsDaily(deps, companyId, meta)`, `agents/scheduler/reminders.ts` `runReminders`, `agents/scheduler/agenda.ts` `runAgenda`, `agents/scheduler/weather.ts` `runWeatherWatch`, `agents/followup/daily.ts` `runFollowUps` (each `async () => {}` with a comment naming the task that fills it: T8, T10, T10, T11, T13). Pause/Run now come in T15; do not read `agent_settings` here.
- Tests: `dueNow` for America/Chicago and America/Los_Angeles across a DST boundary (2026-11-01), the 15-minute window edges, reminder hour from settings; the schedule run sends one job per due company and none for others (InlineJobs / the test queue), and a second run in the same slot sends nothing new (singletonKey). Update the existing exact lists in `test/jobs.test.ts` and `test/pgboss.test.ts` (keep-both order: F3/C1 entries, D1, then G1).

**2. Step handler stubs (`tasks/handlers.ts`)**: `send_personal_texts` (T5), `build_claim_packet` (T7), `create_appointment` (T8), `move_appointment` (T11) registered in `builtInHandlers` returning `{ status: 'failed', error: 'Not built yet.' }` (or the file's equivalent failure shape), each with a `// G1 Task N fills this in` comment, so an approved G1 step never silently succeeds.

**3. Drafting and extraction seams (Ruling GX-B; `providers/llm.ts`)**
```ts
export const DRAFT_KINDS = ['proposal_follow_up', 'lead_follow_up', 'claims_ask_filed', 'claims_ask_adjuster_date', 'claims_ask_outcome', 'reminder', 'weather_move', 'no_show', 'review_request'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
export type JobFacts = { jobId: string; customerFirstName: string; companyName: string; repFirstName: string | null; address: string | null; facts: Record<string, string> };   // facts: plain strings only (dates already formatted)
export type DraftTextsResult = { texts: { jobId: string; body: string }[]; usage: TurnUsage };
export type ClaimReplyFacts = { claimNumber?: string; insurer?: string; adjusterAt?: string /* ISO */; decision?: 'approved' | 'partly' | 'denied' };
// Llm gains:
draftTexts(i: { instruction: DraftKind; facts: JobFacts[] }): Promise<DraftTextsResult>;      // ≤ 25 jobs per call (throw RangeError above)
extractClaimReply(i: { text: string; now: Date; timeZone: string }): Promise<{ facts: ClaimReplyFacts; usage: TurnUsage }>;
```
- `ScriptedLlm` gains a queue per method (`scriptDraft(result | Error)`, `scriptExtraction(result | Error)`, following how it scripts `route`/`summarize` today) and records the inputs it was called with (`draftCalls`, `extractionCalls`); an empty queue → `LlmUnavailableError`.
- The Anthropic adapter (`providers/anthropic/`) gets both methods as stubs throwing `LlmUnavailableError('Not built yet.')` with a `// G1 Task 4` comment (Task 4 implements Opus drafting and Haiku extraction; Ruling DA: Anthropic TypeScript SDK only; no live call in tests or CI).
- **Ruling GX-D:** `config.ts` gains optional `MAPTILER_SERVER_KEY` (string, absent = no static map in claim packets), read only in config like every secret; add it to the test config as absent.
- Tests: ScriptedLlm returns scripted drafts/extractions in order and records inputs; an empty queue throws `LlmUnavailableError`; `draftTexts` with 26 facts throws RangeError; the test app's `llm` has both methods.

**4. Inbound order (Ruling GX-A; `hooks/twilio.ts`)**
- After the inbound text is stored (the existing `insertInboundText` path for a known customer) and after any S1 block (none exists yet), insert one self-contained block:
```ts
// G1 Agents: a reply to a claims text goes to the Claims agent first (Ruling GX-A). S1's storm replies run before this block; D1's Front Desk after it.
const claimsReply = await onClaimsReply(deps, { companyId, customerId, messageId, body, receivedAt: now });
if (claimsReply.consumed) return /* the same response the handler gives after a handled message */;
```
- `agents/claims/replies.ts` `onClaimsReply(deps, msg): Promise<{ consumed: boolean }>` is a stub returning `{ consumed: false }` (Task 8 fills it in, including calling D1's `queueFrontDeskText` itself when it consumes a reply). Keep the block at the place D1's Front Desk call will go after it (D1 T14 has not landed; leave a comment `// D1 Front Desk (queueFrontDeskText) goes after this block`).
- Tests: an inbound text from a known customer calls `onClaimsReply` once (spy through a module mock or a deps hook — prefer injecting through `deps` if the file's style allows), after the message row exists; STOP/HELP/START still short-circuit before it (F3 behaviour unchanged); an unknown sender never reaches it.

**Global:** no lockfile/dependency change; no migration; `// G1 Agents` marks every G1 block in shared files (JOB_NAMES, SCHEDULES, handlers, hooks) so later merges keep-both in the order F3/C1 → S1 → D1 → G1 where the plan says (hooks: S1 → G1 → D1).

**Verify:** `npm run typecheck && npm run lint` (through `ops/bin/slot`); the api tests run only on CI (`ci-check` with `CI_JOBS="Platform E2E"`).
- Commit: `feat(api): G1 skeleton — agent jobs, drafting and extraction seams, inbound order (G1 Task 3)`

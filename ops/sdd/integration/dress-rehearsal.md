# Launch dress rehearsal (2026-10-12)

## Setup

- Checkout: worktree `/home/user/wt/rehearsal`, branch `ops-rehearsal` at `431ea77` (= `origin/launch-integration`
  probe pass 13: F, C1, E1, S1, D1, A1 and G1 merges). `npm ci`, web built (`npm run build -w @roofline/web`).
- Stack: Docker PostGIS (`postgis/postgis:16-3.4`), API, worker and web on `http://127.0.0.1:4410`, all providers fake
  (`FAKE_PROVIDERS=1`, `stack.ts`). No real provider was called. Nothing was pushed.
- New files (spec and helpers only, no product code changed):
  - `apps/web/e2e/rehearsal.spec.ts` (desktop project, 8 tests: journeys a, b, c, d, e1, e2, f, g)
  - `apps/web/e2e/rehearsal.phone.spec.ts` (phone project, 2 tests; the phone project's testMatch is `/(phone|doors)\.spec/`)
  - `apps/web/e2e/rehearsal-helpers.ts` (browser-error collector, "coming soon" check, UI sign-in, Twilio webhook
    signing, a ConversationRelay WebSocket client, the known-bug allowlists)
- Run:
  ```
  cd apps/web
  npx playwright test e2e/rehearsal.spec.ts --project=desktop
  npx playwright test e2e/rehearsal.phone.spec.ts --project=phone
  ```
- What runs outside the UI, and why: Twilio's signed webhooks (`/hooks/twilio/sms`, `/hooks/twilio/voice`,
  `/hooks/twilio/voice-status`) and Twilio's side of the ConversationRelay socket (`ws://…/relay?t=…`: `setup`, one
  `prompt`, wait for the last `text` token, hang up). To sign them the helper gives Acme a number (`+14025550100`,
  sms+voice), turns Front Desk on in `company_settings` (Settings cannot turn it on without a verified forwarding test,
  which needs a real call) and stores a subaccount token encrypted with the stack's `ENCRYPTION_KEY` (read from the API
  process's `/proc/<pid>/environ`, because `stack.ts` makes a random key and does not write it out; `TWILIO_AUTH_TOKEN`
  in the environment is used instead when set). The subaccount SID is set too, else the `texting-registration` job
  provisions a fake subaccount within a minute and overwrites the token. The homeowner link comes from
  `GET /api/proposals/:id/link` (what Copy link copies). `makeItDaytime` moves the company's zone so the send gate
  does not hold texts for quiet hours (as `estimator-helpers.ts` does). Journey f creates its two tasks through the
  existing helpers (`makeAndSendProposal`, `draftAndApproveStormPlan`).
- Every test collects console errors, uncaught page errors and 5xx responses for every page of its context (including
  the homeowner's separate context), and checks the visible text of every visited screen for `/coming soon/i`. Both are
  soft checks so a journey carries on. Known findings are listed in `KNOWN_CONSOLE` / `KNOWN_COMING_SOON`
  (rehearsal-helpers.ts) and reported as test annotations instead of failing; delete an entry when its bug is fixed.

## Baseline suite results

`npx playwright test` (both projects), before any rehearsal file existed: **80 passed, 0 failed, 0 flaky (7.8 min).**

| Project | Spec | Tests | Result |
|---|---|---|---|
| desktop | a11y.spec.ts | 22 | pass |
| desktop | agents-settings.spec.ts | 4 | pass |
| desktop | agents.spec.ts | 9 | pass (includes "the G1 agents say Coming soon", see GAP-1) |
| desktop | approvals.spec.ts | 4 | pass |
| desktop | billing.spec.ts | 2 | pass |
| desktop | calendar.spec.ts | 2 | pass |
| desktop | crm.spec.ts | 6 | pass |
| desktop | estimator.spec.ts | 2 | pass |
| desktop | homeowner.spec.ts | 1 | pass |
| desktop | import.spec.ts | 1 | pass |
| desktop | setup.spec.ts | 3 | pass |
| desktop | shell.spec.ts | 6 | pass |
| desktop | signup.spec.ts | 1 | pass |
| desktop | storm.spec.ts | 2 | pass |
| desktop | today.spec.ts | 3 | pass |
| phone | doors.spec.ts | 2 | pass |
| phone | phone.spec.ts | 10 | pass |

Note: no existing e2e spec drives Front Desk (calls or texts) at all, and none collects console errors, which is why
BUG-1 and BUG-4/5 were invisible to CI.

## Journey results

Final run: `npx playwright test e2e/rehearsal.spec.ts e2e/rehearsal.phone.spec.ts` → **10 passed** (8 desktop + 2
phone; e2 and g are `test.fail` and count as passed because they fail as expected).

| Journey | Desktop | Phone | Notes |
|---|---|---|---|
| a. Sign up a new company, land on Setup, open all six apps from the dock | pass | (existing phone.spec covers sign-up width) | Agents shows "Coming soon" x6 (GAP-1); Calendar logs a 404 (BUG-2) |
| a'. Sign in through the sign-in page | pass (b-f) | pass | `My day` opens itself on the first sign-in of the day and swallows Ctrl+K (the Search button works) |
| b. CRM: new customer (search → New customer, with phone, home, consent) → New job → job ↔ customer links → board → job | pass | pass | Home map shows "The map is having trouble loading" (BUG-1) |
| c. Estimator: job → New proposal → measure window (outline found) → Make proposal → approve send → job's proposal row → proposal says Sent → homeowner link signs (fresh context) → job is Won | pass | pass (to Sent) | Clean: no console errors, no coming soon |
| d. Storm Scout: dock → storm list → storm → "Draft a new plan" → "Open the plan" → approve 5 steps → all Done → results → feed shows "Finished: Storm plan…" | pass | pass (to the review) | Swath map layer rejected on every storm page (BUG-1). Feed rows for a finished plan have no link (by design: `feedHref` links open drafts only) |
| e1. Front Desk: signed inbound text → inbox row "Text" → conversation shows it and the assistant's reply | pass | pass | The open conversation does not refresh, and shows "Nothing was said yet." until the 20 s debounced job runs (BUG-3); the test reloads |
| e2. Front Desk: signed inbound call answered over ConversationRelay → inbox row "Call" → conversation shows what was said and a summary | **known fail** (BUG-4, BUG-5) | not run | Relay works end to end (greeting TwiML, setup, prompt, assistant tokens, hang-up, status 204, call row appears). The conversation then shows "Transcript removed after the retention period" for every turn and "No summary yet." |
| f. Agents: Estimator and Storm Scout cards show Finished today ≥ 1 and "about … hours" saved; totals line; card → agent page; feed lists both; waiting list | pass | pass (overview, feed, waiting, settings) | "Coming soon" on the overview (GAP-1). Waiting list never has Front Desk follow-ups (GAP-2) |
| g. Claims, Scheduler, Follow-up (G1) each fire once and their tasks appear | **gap** (`test.fail`) | n/a | No G1 code on this branch (GAP-1) |
| Cross-app links | pass | pass | dock (6 apps), More sheet (Storm, Front Desk, Agents), customer → job, job → customer, board → job, job → proposal, measure → review, storm → plan, plan list card, agents card → agent page |

## Bugs

### BUG-1: hail swath layer is rejected by MapLibre; no swath ever draws and the home map shows its error banner

- Owner: **S1** (storm). File history: `apps/web/src/shell/map/stormLayer.ts` last changed in 0f43a12 (`s1-i2`).
- Steps: sign in as owner@a.test (seeded fixture storm) → open `/storm/<companyStormId>` (or just `/`).
- Expected: the storm page draws the hail swath coloured by size; the home map has no error banner.
- Actual: the swath map is empty and the console logs
  `Error: layers.swath-fill.paint.fill-color[2]: Numeric branch labels must be integer values.` (twice per storm page).
  On the home map the same layer fails inside `installMapLayers`; `MapView`'s `on('error')` swallows it and shows
  "The map is having trouble loading. Your work is safe." to every user (the e2e build uses the blank style and fetches
  no tiles, so nothing else can raise that banner).
- Evidence: console line above (journeys d, phone Storm); annotation `BUG-1 (S1): home map shows "The map is having
  trouble loading…"` in journey b. Independent check with `@maplibre/maplibre-gl-style-spec` `validateStyleMin` on the
  expression returns exactly that error.
- Suspect: `apps/web/src/shell/map/stormLayer.ts:23-26` `hailFillExpression()` returns
  `['match', ['get', 'thresholdIn'], [0.75, 1], c1, [1.25, 1.5], c2, [1.75, 2], c3, [2.5], c4, [3], c5, c1]`; `match`
  labels must be integers (or strings). Used by `apps/web/src/shell/map/layers.ts:196` and
  `apps/web/src/features/storm/StormSwathMap.tsx:64`. Fix: `step` on `thresholdIn` (0.75 / 1.25 / 1.75 / 2.5 / 3), or
  match on a string/integer level property. Unit tests mock MapLibre, so only a browser catches it.

### BUG-2: Calendar posts /api/calendar/sync on every open and gets a 404 when no calendar is connected

- Owner: **C1** (CRM, calendar).
- Steps: sign in (or sign up a new company), open Calendar from the dock.
- Expected: no failed request when there is nothing to sync.
- Actual: `POST /api/calendar/sync` → 404; Chromium logs
  `Failed to load resource: the server responded with a status of 404 (Not Found) @ …/api/calendar/sync` on every visit.
  Harmless to the user (the web ignores it) but noisy for monitoring and every console-clean check.
- Evidence: journey a console log (known-bug annotation).
- Suspect: `apps/web/src/features/calendar/api.ts:28-35` (sync on every mount) against
  `apps/api/src/routes/calendar-connect.ts:279-281` (`if (!conn) throw new AppError(404, …)`). Fix one side: answer
  204/202 with no connection, or call sync only when the connection query says one exists.

### BUG-3: an open Front Desk conversation never refreshes, and an inbound text is invisible for the first 20 s

- Owner: **D1** (front desk).
- Steps: Front Desk on; a text arrives; open it from the inbox.
- Expected: the customer's text shows at once, and the assistant's reply appears without a reload.
- Actual: "What was said" says "Nothing was said yet." while the inbox row already shows the text. Turns are written only
  by the debounced `fd-text` job (`FD_TEXT_DEBOUNCE_SECONDS = 20`), and the conversation query has no polling or
  invalidation, so nothing appears until the user reloads (after 20 s). With the assistant down or Front Desk texts
  off, a text is never shown in the conversation at all.
- Evidence: journey e1 first run failed with the conversation open for 60 s ("Nothing was said yet."); passes when the
  test reloads every 5 s (shows after about 20 s). Same on phone.
- Suspect: `apps/web/src/features/front-desk/conversation-api.ts` `useConversation` (no `refetchInterval`, unlike the
  inbox list in `inbox-api.ts:38,49`), and the detail read in `packages/db/src/repos/conversation-inbox.ts` (~line 336)
  shows `conversation_turns` only, not the inbound `messages` row.

### BUG-4: a voice call is never linked to its conversation (no summary, no call details)

- Owner: **D1** (front desk).
- Steps: Front Desk on (ring-first 0); a call arrives (`/hooks/twilio/voice`), Twilio connects the relay, the caller
  says one sentence, hangs up, `voice-status completed` arrives; wait for `fd-after-call` (5 s); open the call in the
  inbox.
- Expected: the conversation shows the caller's words, the assistant's answer, the call (status, recording) and an
  after-call summary/outcome.
- Actual: summary "No summary yet." forever; the conversation's `calls` list is empty; every turn reads "Transcript
  removed after the retention period".
- Evidence: after the call, `select conversation_id, transcript_stored, status from calls where call_sid = …` →
  `{"conversation_id":null,"transcript_stored":false,"status":"ended"}` (journey e2 annotation). The relay itself
  answered (assistant tokens received).
- Suspect: `apps/api/src/front-desk/engine.ts:100-136` `start()` inserts the conversation but nothing writes
  `calls.conversation_id` (`packages/db/src/repos/calls.ts:97-110` `updateCall` cannot even set it). Consequences:
  `apps/api/src/front-desk/after-call.ts:102-106` skips the summary when `call.conversationId === null`;
  `conversation-inbox.ts:306-307` finds no calls for the conversation; `ConversationView.tsx`
  `turnTranscriptStored` gets `[]`, `[].every(...)` is true, so it shows the wrong "removed after the retention period"
  line.

### BUG-5: call transcripts are never shown, because `calls.transcript_stored` is never set true

- Owner: **D1** (front desk).
- Steps / evidence: as BUG-4 (`transcript_stored: false` on a call with no objection).
- Expected: transcripts kept unless the caller objects (or retention is 0 days).
- Actual: the column defaults to false (`packages/db/migrations/0019_front_desk_schema.sql:35`) and the only writer sets
  it false on an objection (`apps/api/src/front-desk/recording.ts:83`). `getConversationDetail` hides the text of every
  call turn whose call is not `transcript_stored` (`packages/db/src/repos/conversation-inbox.ts` ~line 360,
  `kept = t.callId === null ? true : storedByCall.get(t.callId) === true`), and `after-call.ts:107` reads it before
  summarizing. So even once BUG-4 is fixed, every call transcript is hidden and never summarized. Fix: set it true when
  the call starts (relay setup) unless retention is 0, or flip the default.

## Gaps

- **GAP-1 (G1): Claims, Scheduler and Follow-up are not on launch-integration.** The `g1-agents` merge in 431ea77
  (`cddd1c2`) brought only `ops/sdd/g1/*` (`git diff --stat cddd1c2^1 cddd1c2`): `origin/g1-agents` holds G1's ledger;
  the code (T3-T17, `g1AgentOn`, `writeAgentNote`, claims/scheduler/follow-up jobs, `features/claims`) is on `g1-w7` /
  `g1-full` and was never merged into `g1-agents`. On this branch `packages/shared/src/agents.ts:65`
  `G1_AGENTS_SHIPPED = false`, there are no G1 jobs in the worker's queue list, no routes, and the Agents window shows
  the three cards as "Coming soon" (6 lines; `agents.spec.ts` "the G1 agents say Coming soon" asserts it). Journey g
  cannot run. Owner G1 (merge `g1-full` into `g1-agents`, then the probe).
- **GAP-2 (A1 x D1): Front Desk follow-ups never reach the Waiting list.** `apps/api/src/routes/agents-feed.ts:96-106`
  `frontDeskFollowUps` is still the A1 stub that returns `[]`, with the merge rule "when D1 lands, replace this body".
  D1 is merged; the after-call `followUps` are written only into the timeline activity. Owner A1 (merge rule), with D1.
- Front Desk cannot be turned on from Settings without a verified forwarding test (by design, needs a real call); the
  rehearsal sets `company_settings` directly. Not a bug, but no fake/test path exists for an owner trying the product
  without a carrier.

## Console errors seen

| Where | Message | Finding |
|---|---|---|
| `/storm/:id` (desktop and phone) | `Error: layers.swath-fill.paint.fill-color[2]: Numeric branch labels must be integer values.` (2 per visit) | BUG-1 |
| `/calendar` | `Failed to load resource: … 404 (Not Found) @ /api/calendar/sync` | BUG-2 |
| `/` (home map) | none logged (MapView swallows the error) but the error banner shows | BUG-1 |

No uncaught page errors and no 5xx responses on any screen in any journey (desktop or phone, including the homeowner
page). Every other visited screen was console-clean.

## "Coming soon" check

Phrases searched: `/coming soon/i` on the visible text of every visited screen (covers `dock.comingSoon`,
`agentsCommon.comingSoon`, `agentsWindow.status.coming_soon`, `agents.agentComingSoon`, `comingSoon.*`,
`jobs/quotes/calendar/appointments.comingSoon`).

| Screen | Result |
|---|---|
| `/agents` (desktop and phone) | **"Coming soon" x6** (Claims, Scheduler, Follow-up cards; GAP-1) |
| `/agents/claims`, `/agents/scheduler`, `/agents/follow-up` | not reached (GAP-1; these routes render `agents.agentComingSoon`) |
| `/sign-up`, `/settings/setup`, `/storm`, `/storm/:id`, `/storm/plans/:id`, `/front-desk`, `/front-desk/:id`, `/estimator`, `/estimator/measure/:id`, `/estimator/proposals/:id`, `/approvals/:id`, `/jobs`, `/jobs/new`, `/jobs/:id`, `/customers/new`, `/customers/:id`, `/calendar`, `/today`, `/agents/estimator`, `/agents/feed`, `/agents/waiting`, `/settings/agents`, `/settings/front-desk`, `/p/:token`, phone `/` | clean |

## Routing and status (S1 lead)

| Finding | Owner | Status |
|---|---|---|
| BUG-1 hail swath `match` with decimal labels | S1 | **Fixed on `s1-storm` 89ab4c4**: a `step` expression, plus a test that compiles the expression with MapLibre's style spec. Remove its `KNOWN_CONSOLE` entry once the probe takes s1-storm. |
| BUG-2 `/api/calendar/sync` 404 on every Calendar open | C1 | Routed to the C1 lead |
| BUG-3 an open Front Desk conversation does not refresh | D1 | Routed to the D1 lead |
| BUG-4 `calls.conversation_id` is never set | D1 | Routed to the D1 lead |
| BUG-5 `calls.transcript_stored` is never true | D1 | Routed to the D1 lead |
| GAP-1 the G1 agent code is not on `g1-agents` | G1 | Routed to the G1 lead and the controller |
| GAP-2 the `frontDeskFollowUps` stub | A1 (with D1) | Routed to the A1 lead |

Docker works on these cloud boxes once `dockerd` is started (`nohup dockerd &` as root). The whole rehearsal ran
locally that way.

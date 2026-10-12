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

## Pass 14 re-run (44b263f7)

Base: `ops-rehearsal` 9b902732 = the rehearsal commit a23bf27 + `launch-integration` 44b263f7 (probe pass 14). `npm ci`
clean (`playwright-core` only 1.56.1), `npm run build -w @roofline/web`. `.stack.json` now carries the stack's
`encryptionKey`, so the helper reads it from there (the `/proc` lookup is only a fallback). One stack at a time.

Full run, `npx playwright test e2e/rehearsal.spec.ts e2e/rehearsal.phone.spec.ts`: **11 passed** (9 desktop + 2
phone). e2 is still `test.fail` and fails as expected (BUG-4/5).

### Journey g: Claims, Scheduler, Follow-up (GAP-1 closed)

g no longer uses `test.fail`. It runs as one desktop journey, through the UI except where noted:

| Step | How | Result |
|---|---|---|
| Agents window, the three cards | UI | Paused with Turn on; no "Coming soon" |
| Claims data: customer + job, then Add claim details (Prairie Mutual, CL-50101, Status Filed) | UI, then DB backdates `claims.status_changed_at` 6 days (no UI to move time; default nudge waits are 3/5/7) | saved |
| Scheduler data: customer + job, then Book inspection for tomorrow 10:00 (company zone) | UI | appointment saved |
| Follow-up data: customer + lead job | UI, then DB backdates the job 10 days | — |
| Each agent: Turn on (rules sheet) → Check claims now / Check tomorrow now / Find follow-ups now | UI | "You can run it again at…" shows; the worker runs `claims-daily` / `scheduler-reminders` / `followup-daily` |
| Each plan, found on Waiting (Open link) → review → Approve | UI (the test polls the database for the task id) | `claims_nudges`, `reminders`, `follow_ups` tasks each made once; all steps Done |
| Texts sent | DB check | an outbound text through the fake SMS to each of the 3 customers |
| Agents window | UI | each card: Finished today ≥ 1; "Time saved this month: less than half an hour (estimate)" (Claims ≈ $1, Scheduler ≈ $0, Follow-up ≈ $1); not Coming soon |
| Agent pages /agents/claims, /agents/scheduler, /agents/follow-up | UI | Recent work row Done, with "less than half an hour (estimate)"; the kind shows raw (BUG-6) |
| Feed | UI | rows for Claims, Scheduler and Follow-up |

The approve, send and minutes counting chain works for all three agents. A few texts count as a few minutes, so the
cards read "less than half an hour" and Scheduler's money line rounds to "≈ $0", which is correct but looks odd (not
filed as a bug).

### "Coming soon" check

The GAP-1 entry is removed from `KNOWN_COMING_SOON` (now empty), so any "coming soon" on any screen fails a test.
**No screen says "coming soon"** on desktop or phone. That covers `/agents`, `/agents/claims`, `/agents/scheduler`,
`/agents/follow-up`, `/agents/estimator`, `/agents/feed`, `/agents/waiting`, `/settings/agents` and
`/settings/front-desk`, plus every screen listed in the first pass and the new `/calendar/new`,
`/calendar/appointments/:id` and the G1 reviews `/approvals/:id`.

### GAP-2: Front Desk follow-ups on Waiting (closed)

New journey h. A customer and job are made in the UI, and the job gets the next step "Call back about the leak" in the
Edit sheet. The customer texts in through the real signed webhook, which creates a conversation filed under the
customer. The conversation's `outcome` is then set to `message` in the DB. That field is what the after-call summary
writes, and the fake model and BUG-4 keep it from being set by a real flow. Result: `/agents/waiting` lists exactly one
Front Desk row, "A caller left a message. Next step: Call back about the leak", linking to the job. The Front Desk card
reads "Waiting on you: N", where N is the number of Front Desk rows on the list. Pass.

### Earlier findings on pass 14

| Finding | Status on 44b263f7 |
|---|---|
| BUG-1 (S1) hail `match` labels | **still present**: `stormLayer.ts:23-26` unchanged; 89ab4c4 is not an ancestor of HEAD. Console error on every storm page; home map banner. Allowlist entry kept. |
| BUG-2 (C1) calendar sync 404 | still present (journey a). Allowlist entry kept. |
| BUG-3 (D1) conversation does not refresh; text invisible until the fd-text job | still present (`useConversation` has no refetch; e1 and the phone test still need reloads) |
| BUG-4 (D1) call not linked to its conversation | still present: `{"conversation_id":null,"transcript_stored":false,"status":"ended"}` after a relay call |
| BUG-5 (D1) `transcript_stored` never true | still present (same evidence) |
| GAP-1 (G1) | closed (journey g) |
| GAP-2 (A1 x D1) | closed (journey h) |

### New bug

#### BUG-6: G1 task kinds show as raw words in an agent's Recent work

- Owner: **G1** (with A1, who owns `copy/status.ts`).
- Steps: run any G1 agent once (journey g), then open `/agents/claims`, `/agents/scheduler` or `/agents/follow-up`.
- Expected: Recent work names the work in plain words, e.g. "Claim check-ins", "Reminders for tomorrow", "Follow-ups".
- Actual: the row's kind reads "claims nudges", "reminders" and "follow ups": the snake_case kind with the underscores
  replaced.
- Evidence: journey g annotations: `/agents/claims Recent work kind text: "claims nudges"`, `/agents/scheduler …
  "reminders"`, `/agents/follow-up … "follow ups"`. These are reported as `known-bug` annotations, so the test passes.
- Suspect: `apps/web/src/copy/status.ts:21-30` `TASK_KIND_LABEL` has only the launch kinds. `RecentTasks.tsx`
  `kindWords` falls back to `plain(kind)`. Add `claims_nudges`, `reminders`, `follow_ups`, `weather_moves`, the
  no-show and agenda kinds, and the Front Desk `call` kind.

## Routing update (S1 lead, after pass 14)
- **BUG-1:** fixed on s1-storm 89ab4c4. The sentinel was asked to take s1-storm 1f3ce1d or later.
- **BUG-2:** the controller forwarded it to the C1 lead.
- **BUG-3:** the D1 lead routed it to the E1 lead's `d1-rev-c`. The missing inbound messages were fixed by d1-rev-d (df798d1).
- **BUG-4:** D1 Task CV (`d1-cv`).
- **BUG-5:** D1 Task RA (`d1-ra`).
- **BUG-6:** sent to the A1 lead, who owns `copy/status.ts`, and to the controller for G1.
- **GAP-1 and GAP-2:** closed. Both came from a stale probe; G1's code and A1 T21/T22 are on pass 14.

## Pass 16 dry run (e93267b9)

Base: `ops-rehearsal` 5e3b3fe1 = the pass 14 rehearsal + `launch-integration` e93267b9 (probe pass 16: CV, RA,
RC-2/3/4, rev-*, demo-mode, the BUG-1 fix from s1-storm 85a68e7; **not** D1's RC-1). `npm ci` clean, `npm ls
playwright-core` only 1.56.1, `npm run build -w @roofline/web` OK. One stack at a time. No product code changed.

### Spec changes for pass 16

- BUG-1 and BUG-2 are removed from `KNOWN_CONSOLE`. Journey b now requires that the home map shows no error banner.
  Journey d now requires that the storm's swath map draws: a new helper, `drawnShare`, screenshots the map region and
  counts non-background pixels; it measured 0.129, against 0 before the fix.
- e1 and the phone test no longer reload: the open conversation must update by itself.
- e2 is no longer `test.fail`. It requires the call row to be linked to its conversation with `transcript_stored`
  true, the caller's and the assistant's words to be visible, no "removed after the retention period" line, and an
  after-call summary.
- **Relay handshake (spec-only):** pass 16 now requires `X-Twilio-Signature` on the ConversationRelay WebSocket
  upgrade, signed over the wss URL with no fields. The helper now uses the `ws` client (Node's built-in WebSocket can't
  send headers) and signs the upgrade as Twilio does.
- Journey g now requires the plain kind labels from `TASK_KIND_LABEL` (BUG-6).
- New journey i covers the claims reply ("claims-ack") path.
- `signInViaUi` now closes My day when it opens itself on the first sign-in of the company's day. In the full-suite
  run, My day opened a moment after landing and swallowed journey d's dock click (spec-only race; My day opening
  itself is by design).
- `KNOWN_CONSOLE` has one new entry, BUG-7 (below).
- `run-now` labels are now `Partial<Record<…>>` in `copy/agents.ts`, so the spec uses `!` on them.

### Item results

| Item | Result | Evidence |
|---|---|---|
| BUG-1 (S1) hail swath | **fixed** | no console error on storm pages; swath map 12.9% drawn; no home-map banner |
| BUG-2 (C1) calendar sync 404 | **fixed** (`/sync` answers 204 with no connection); allowlist entry removed | journey a console-clean on `/calendar` |
| BUG-3 (D1) conversation refresh | **fixed** (rev-c: `useConversation` polls, 30 s idle) | no reload: the inbound text showed at once (0 s) and the assistant reply after 30 s; phone the same |
| BUG-4 (D1) call to conversation link | **fixed** (CV) | `{"conversation_id":"b108e838-…","transcript_stored":true,"status":"ended"}`; transcript visible |
| BUG-5 (D1) transcript_stored | **fixed** (RA) | same row; after-call summary "Scripted summary." shown |
| BUG-6 (G1) task kind labels | **fixed** | "Claim check-ins", "Appointment reminders", "Lead follow-ups" |
| GAP-1, GAP-2 | still closed | journeys g, h pass |
| claims-ack | **pass (hand-on branch); the ack branch is not reachable on the e2e stack** | see journey i below |
| New: BUG-7 (demo-mode) | **failing** (allowlisted) | below |
| Existing suite: `a11y.spec.ts` "storm detail" | spec flake (order dependent) | below |

### Journey results (final rehearsal run: 12 passed in 5.8 min)

| Journey | Desktop | Phone |
|---|---|---|
| a. Sign up, Setup, six apps from the dock | pass | (phone.spec covers sign-up) |
| b. CRM: customer → job → links, board; home map without banner | pass | pass |
| c. Estimator: measure → proposal → send → homeowner signs → Won | pass | pass (to Sent) |
| d. Storm: list → storm (swath drawn) → draft plan → approve 5 → results → feed | pass | pass (to the review) |
| e1. Front Desk inbound text, live update, assistant reply | pass | pass |
| e2. Front Desk inbound call: linked, transcript, summary | **pass** (was test.fail) | — |
| f. Agents: Estimator and Storm Scout tasks and minutes saved | pass | pass (overview, feed, waiting) |
| g. Claims, Scheduler, Follow-up fire once; cards, pages (plain labels), feed, minutes | pass | pass (G1 pages, no coming soon) |
| h. Front Desk follow-up once on Waiting = card count | pass | — |
| i. Claims reply (claims-ack path) | pass | — |
| "Coming soon" on any visited screen | none | none |
| Console errors / page errors / 5xx | only BUG-7 (allowlisted); no page errors; no 5xx | same |

### Journey i: claims reply (claims-ack)

The code is in `apps/api/src/agents/claims/replies.ts` (Ruling GX-V). A homeowner who had a Claims check-in text in
the last 7 days, and who has an open claim, texts back. The inbound hook `onClaimsReply` consumes the text, so Front
Desk does not answer it at once, and queues the `claims-reply` job (5 s delay). The job asks the model to extract
facts. When something was noted and the text has no '?', it sends "Thanks, got it." (dedupe
`claims-ack:<message id>`) into the same Front Desk conversation through the send gate. Otherwise it hands the text to
Front Desk.

Driven once:
1. A Filed claim made in the UI, backdated 6 days.
2. Claims turned on and run; the check-in plan approved and sent.
3. The homeowner replies through the signed webhook: "We filed it, the claim number is CL-77001 with Prairie Mutual."

Result: the reply is answered **exactly once**, through the fake SMS (`[{"body":"Sorry, could you say that
again?","status":"sent","ack":false}]`). The conversation stays the assistant's (`handled_by: assistant`). A second,
ordinary text in the same conversation gets its own Front Desk answer, so Front Desk is not silenced.

**Limit, for the final run:** the e2e stack's model is `ScriptedLlm` (`deps.ts` `createLlm`, `FAKE_PROVIDERS`), and
demo mode's `demoLlm()` is too. Neither has a scripted `extractClaimReply`, so the job always gets
`LlmUnavailableError` and takes the hand-on branch. The "Thanks, got it." branch is covered only by
`apps/api/test/claims-ack.test.ts`. The spec accepts either branch: it requires exactly one answer, and if that answer
is the ack, that its text is "Thanks, got it.". To drive the ack branch end to end, the stack needs a scripted
extraction for FAKE_PROVIDERS (owner G1, with the test stack). Recorded as a gap, not a bug.

### New bug: BUG-7 (demo-mode) — GET /api/demo is a 404 on every full page load when demo mode is off

- Owner: **demo-mode** (`ops/sdd/demo`, commit 55415dd4).
- Steps: any signed-in page with DEMO_MODE off (the production setting), e.g. sign in and open `/`.
- Expected: no failed request (the demo probe is part of every page load).
- Actual: `GET /api/demo` → 404, and Chromium logs `Failed to load resource: the server responded with a status of
  404 (Not Found) @ …/api/demo`. It happens once per full page load (it is cached for the session, but every hard
  navigation asks again), so every customer's console shows an error on every visit. This is the same pattern as BUG-2.
- Evidence: a known-bug annotation on every journey in this run (e.g. a on `/settings/setup`, d on `/storm/:id`, the
  phone tests on the G1 pages).
- Suspect: `apps/api/src/app.ts:312-314` mounts `GET /api/demo` only `if (config.DEMO_MODE)`, while
  `apps/web/src/features/demo/api.ts:17-33` `useDemoMode` always asks. Fix: always answer `GET /api/demo` with
  `{ demo: false }` (or 204), or put the flag in an existing response (`/api/auth/me` or the config the shell already
  loads).

### Full existing e2e suite on pass 16

`npx playwright test` (both projects; it includes the 12 rehearsal tests): **117 passed, 2 failed (15.4 min).**
- The existing specs: **106 passed, 1 failed**. Per spec: a11y 29/30, agents-settings 4, agents 9, approvals 4,
  billing 2, calendar 2, crm 6, estimator 2, front-desk 11, homeowner 1, import 1, more-agents 3, public-forms 2,
  setup 3, shell 6, signup 1, storm 2, today 3; phone: doors 2, phone 13.
- `a11y.spec.ts:193` "storm detail has no serious accessibility violations" failed with a strict-mode violation:
  `getByRole('heading', { level: 1 })` resolved to 2 elements, the window title "Storm" and StormDetail's own
  `<h1>` "Omaha, NE". Run alone it passes, so whether the locator matches one or two elements depends on how fast the
  storm loads. Spec issue for **S1** (a11y.spec.ts:197; scope the locator to the storm name). Product note for S1:
  `StormDetail.tsx:42` renders a second `<h1>` inside a window that already has one; an `<h2>` would read better.
- Rehearsal journey d failed in that run because of the My day race described above (spec fixed). The rehearsal
  re-run after the fix: 12/12.

## Follow-ups (controller, after the pass 16 dry run)
- **BUG-7** (`GET /api/demo` returns 404 with demo mode off): routed to the demo-mode owner. The sentinel folds the fix into the probe.
- **S1 a11y flake** (the storm-detail heading race): fixed on s1-storm 4e5954ee.
- **G1 test gap (not blocking):** the claims-ack "Thanks, got it." branch cannot run on the e2e stack, because the fake model has no scripted claim extraction. Only `apps/api/test/claims-ack.test.ts` covers it. Follow-up for G1: give the e2e/demo fake model a scripted extraction, so the acknowledgement runs end to end.

## Final run (bb23b03e)

Base: `ops-rehearsal` 50dce215 = the pass-16 rehearsal spec (be4ffd03) + `launch-integration` bb23b03e (final pass-16
probe, with D1's RC-1/RC-1b). `npm ci` was clean, `npm ls playwright-core` shows only 1.56.1, and the web build
succeeded. One stack at a time. **No spec or product change was needed:** RC-1 broke nothing in the rehearsal. The SMS
flow, the claims reply hand-on, unknown numbers and the conversation views all passed unchanged.

**Verdict: PASS.** The only failures are the two known, expected items: BUG-7 (allowlisted) and the a11y
storm-detail flake.

### Rehearsal (desktop + phone): 12 passed (5.9 min)

| Journey | Desktop | Phone |
|---|---|---|
| a. Sign up, Setup, six apps from the dock | pass | covered by phone.spec |
| b. CRM: customer → job → links, board; no home-map banner | pass | pass |
| c. Estimator: measure → proposal → send → homeowner signs → Won | pass | pass (to Sent) |
| d. Storm: swath drawn (12.9%) → draft plan → approve 5 → results → feed | pass | pass (to the review) |
| e1. Front Desk inbound text, updates without reload (text at 0 s, reply at 30 s) | pass | pass |
| e2. Front Desk inbound call: linked, transcript kept and shown, summary | pass | — |
| f. Agents: Estimator and Storm Scout tasks, minutes saved | pass | pass (overview, feed, waiting) |
| g. Claims, Scheduler, Follow-up fire once; plain labels; minutes; feed | pass | pass (G1 pages) |
| h. Front Desk follow-up once on Waiting = card count | pass | — |
| i. Claims reply answered exactly once (hand-on branch); Front Desk still on | pass | — |

Evidence from the run:
- e2: `{"conversation_id":"72615ddc-…","transcript_stored":true,"status":"ended"}`, summary "Scripted summary."
- g: Recent work labels "Claim check-ins", "Appointment reminders", "Lead follow-ups".
- i: one answer, `"Sorry, could you say that again?"`, sent; the conversation is `handled_by: assistant`. The
  acknowledgement branch is still not reachable on fake stacks (see the pass 16 dry run).

### Console, 5xx and "coming soon"

- Console: the only error is BUG-7 (`GET /api/demo` 404 with demo mode off), allowlisted, 45 occurrences across the
  12 tests (once per full page load). Its fix lands in a follow-up head; drop its `KNOWN_CONSOLE` entry then. No other
  console errors.
- Uncaught page errors: none. 5xx responses: none.
- "Coming soon": none on any visited screen, desktop or phone, including `/agents`, `/agents/claims`,
  `/agents/scheduler`, `/agents/follow-up`, `/settings/agents` and `/settings/front-desk`.

### Full existing e2e suite: 118 passed, 1 failed (15.8 min)

- Includes the 12 rehearsal tests (all pass). Existing specs: **106 passed, 1 failed**. Per spec: a11y 29/30,
  agents-settings 4, agents 9, approvals 4, billing 2, calendar 2, crm 6, estimator 2, front-desk 11, homeowner 1,
  import 1, more-agents 3, public-forms 2, setup 3, shell 6, signup 1, storm 2, today 3; phone: doors 2, phone 13.
- The one failure is the known flake `a11y.spec.ts:193` "storm detail": a strict-mode violation, because
  `getByRole('heading', { level: 1 })` matched both the window's "Storm" and the page's "Omaha, NE". Re-run alone:
  **passed**. Its fix is not in this head (owner S1).

### New bugs

None.

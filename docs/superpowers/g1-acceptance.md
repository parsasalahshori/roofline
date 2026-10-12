# G1 acceptance checklist (spec section 9)

Status: the API, db, shared-package and web component tests below run in CI (`.github/workflows/ci.yml`, the Platform job); the API and db tests are database-backed and, with no Docker on the build machine, were not run locally. The one exception is `apps/api/test/no-insurer-contact.test.ts`, a static check that needs no database and was run locally. The Playwright specs were only listed locally with `npx playwright test --list -c apps/web/playwright.config.ts` and are proven on CI through the E2E job (`--project desktop --project phone`). No live model, Twilio, MapTiler or NWS call happens in CI: the end-to-end stack and the API tests use `FAKE_PROVIDERS`, the scripted model (`ScriptedLlm`, which falls back to templates), the fake SMS and recorded forecast fixtures (see Gaps).

Paths are under `apps/api/test/` (API), `apps/web/e2e/` (Playwright), `apps/web/test/` (web components), `packages/<name>/test/` and `docs/superpowers/`. Test names are quoted exactly as written in the files.

## Unit
- **Finder rules and limits (days, caps, stop conditions, cross-agent spacing)**
  - `packages/shared/test/more-agents.test.ts`: "match the brief values" (limit constants); "replied: exactly 3 days after an inbound text is allowed, 1 minute less is blocked"; "storm_text: exactly 3 days after a storm text is allowed, 1 minute less is blocked"; "spacing: a proposal entry exactly 3 days ago is allowed, 1 minute less is blocked"; "spacing is cross-kind: a lead text 2 days ago blocks proposal and review"; "claims_spacing: a claims entry 4 days ago is allowed, 1 minute less is blocked"; "Decision 8 across agents: a claims text blocks a proposal text for 3 days, and the other way round"; "claims_max: 4 claims entries on the same job block, 3 allow"; "reminder and no_show are always allowed, even with fresh contact and log".
  - `packages/shared/test/more-agents.test.ts` (due rules): "first text: due when sent exactly 3 days ago, not at 3 days minus 1 minute"; "first text: a view exactly 2 days ago makes it due, 1 minute less does not"; "second text: 1 text sent, due at exactly 4 days after the last text"; "call_rep: 2 texts sent and 4 days since the last text, 1 minute less is null"; "due at exactly 2 days after creation, not at 2 days minus 1 minute"; "not due when lost, when an appointment exists, or after a text was sent"; "not_filed: ask_filed at exactly 3 days after inspection"; "filed: ask_adjuster_date at exactly 5 days in status, only when no adjuster date"; "adjuster_scheduled: ask_adjuster_outcome at exactly 7 days after the adjuster date".
  - `packages/db/test/follow-up-finder.test.ts`: "a lead 2 days old with no appointment and a mobile phone is returned"; "a lead 1 day old is not returned"; "a customer who texted in yesterday is not returned"; "a lead with a scheduled appointment is not returned, nor is a lost job"; "a do-not-contact customer is not returned"; "a lead that already got a lead follow-up text is not returned"; "an install completed 3 days ago with delay 3 is returned"; "an install completed 2 days ago, or 31 days ago, is not returned"; "a job that already has a review log row is not returned"; "consent none and express are skipped; attested and written are returned"; "after a nudge the job is not returned 6 days later, and is returned 8 days later".
  - `packages/db/test/follow-up-log.test.ts`: "n counts per job and kind, and restarts for another kind"; "the same message id twice adds one row"; "returns the latest inbound only, null when none"; "returns the latest storm outbound only, null when none".
- **Weather thresholds**
  - `packages/shared/test/more-agents.test.ts`: "rain threshold is inclusive: 60 is rain, 59 is not"; "wind threshold is inclusive: gust 25 is wind, 24 is not"; "a null gust is never wind risk"; "both reasons are reported in order rain, wind"; "out-of-hours spikes at local 02:00, 06:00 and 18:00 do not count"; "in-hours spikes at local 07:00 and 17:00 count (18:00 end is exclusive)"; "a forecast spanning midnight: only work hours count across the whole list"; "Saturday morning counts, Saturday afternoon and Sunday do not (DEFAULT_WORK_HOURS)".
  - `packages/db/test/scheduler-weather.test.ts`: "returns only scheduled, unarchived, assigned installs with coordinates inside the window"; "includes own appointments and busy blocks; excludes canceled, other users and the excluded one".
- **Claim status transitions**
  - `packages/shared/test/more-agents.test.ts`: "every status has a flow entry, and closed has none"; "every target is a valid status"; "exact flow lists per the brief"; "canMoveClaim follows the flow"; "canMoveClaim is false for the same status".
  - `packages/db/test/claims.test.ts`: "one claim per job: a second save updates the same row"; "events are written on a status change only".
  - `apps/api/test/claims-replies.test.ts`: "decision approved moves status only when canMoveClaim allows".
- **Guards, including the claims guard**
  - `packages/shared/test/claims-guard.test.ts`: "claimsGuard refuses"; "claimsGuard allows"; "are in first-found order"; "are de-duplicated".
  - `packages/shared/test/g1-steps.test.ts`: "a text about prices is refused with the exact message"; "one bad message among clean ones is refused"; "a review request must be marketing".
  - `apps/api/test/personal-texts.test.ts`: "a claims guard hit at send time blocks only that message".
  - `apps/api/test/claim-packet-pdf.test.ts`: "fixed strings pass claimsGuard, and so does a full packet"; "never mentions deductible or adjuster".
- **Extraction parsing**
  - `apps/api/test/anthropic-extract.test.ts`: "extracts insurer, claim number and adjuster time, with no decision key"; "drops an adjuster time a year out and keeps the other fields"; "drops a 41-character claim number and an 81-character insurer"; "a refusal rejects LlmRefusedError, which is also an LlmUnavailableError"; "unparseable text rejects LlmUnavailableError"; "an all-null answer gives empty facts".
- **Step payloads and previews**
  - `packages/shared/test/g1-steps.test.ts`: "message count: 0 and 101 fail, 1 and 100 pass"; "duplicate customerIds fail"; "body length: empty fails, 480 passes, 481 fails; a NUL fails"; "21 messages show 20 bodies and "and 1 more""; "create_appointment good and bad cases"; "move_appointment good and bad cases"; "none is user-creatable".

## Integration
- **Each daily job drafts the right task and steps**
  - Follow-up: `apps/api/test/followup-daily.test.ts`: "a lead 2 days old with no appointment gets one plan with two inspection times"; "a stuck job gets a next step and one live task; the next day changes nothing". `apps/api/test/followup-proposals.test.ts`: "a proposal sent 3 days ago gets a text in the daily task"; "the second text goes 4 days after the first, not 3"; "after two texts the rep is asked to call once, and no third text is sent"; "a lead text and a proposal text make one task with two steps". `apps/api/test/followup-reviews.test.ts`: "an install completed 3 days ago gets a request with the link"; "the step is marketing, kind review, dedupePrefix followup-review:2026-10-13, and the body ends with the STOP line".
  - Claims: `apps/api/test/claims-nudges.test.ts`: "asks_filed after 3 days from inspection, asks_adjuster_date 5 days after filed, asks_outcome 7 days after adjuster visit"; "cap of 25 per run".
  - Scheduler: `apps/api/test/scheduler-reminders.test.ts`: "texts tomorrow's inspection, install and adjuster visits only"; "the step carries the dedupe prefix for tomorrow"; "the plan expires at 9 PM local today". `apps/api/test/scheduler-weather.test.ts`: "rain on the install day: move to the next clear free workday, then text"; "wind alone reads as a wind task". `apps/api/test/scheduler-no-show.test.ts`: "makes one needs-approval task with two times". `apps/api/test/scheduler-no-show-trigger.test.ts`: "marking no-show sends the job and makes one task with two times".
  - Schedule: `apps/api/test/g1-schedule.test.ts`: "the hours each job runs at"; "weather runs at 6 and 14, agenda at 18, follow-ups at 9"; "sends the job only for the company whose local time is in the window".
- **Pause skips**
  - `apps/api/test/g1-agent-on.test.ts`: "with no agent_settings row (G1 default: paused) it does nothing"; "after setPaused false it runs and makes its plan"; "paused again after being on, it stops".
  - `apps/api/test/followup-daily.test.ts`: "paused makes nothing; unpaused makes the plan". `apps/api/test/claims-nudges.test.ts`: "paused: no agent_settings row means no task". `apps/api/test/scheduler-reminders.test.ts`: "paused: no agent_settings row makes nothing"; "paused row (setPaused true) makes nothing". `apps/api/test/scheduler-weather.test.ts`: "a paused scheduler makes nothing". `apps/api/test/scheduler-agenda.test.ts`: "paused row sends nothing, and agent on sends".
- **Run now**
  - `apps/api/test/agents-run-now.test.ts`: "%s run now while paused is 409 Turn this agent on first. and sends nothing" (claims, scheduler, follow_up); "a second G1 run within five minutes is 409 and sends no second job"; "claimRunNow leaves a fresh G1 agent paused and a fresh launch agent on"; "claimRunNow never changes an existing G1 row: a turned-on agent stays on".
- **Texts go through the gate with the right purpose**
  - `apps/api/test/personal-texts.test.ts`: "texts two customers with their own bodies and logs one follow_up_log row each"; "a rerun of the same step texts nobody twice"; "a review request to an express customer is blocked by the gate"; "quiet hours schedule the text"; "result counts: sent, scheduled and blocked add up exactly".
  - `apps/api/test/followup-reviews.test.ts`: "the step is marketing, kind review, dedupePrefix followup-review:2026-10-13, and the body ends with the STOP line".
- **Packet PDF contents (hail line, spotter rows, measurement label)**
  - `apps/api/test/claim-packet-pdf.test.ts`: "hail found: the line reads Radar-estimated hail up to 1.5 inches (NOAA MRMS) on June 14, 2026"; "every hail line says Radar-estimated"; "no hail: No radar hail found at this address on June 14, 2026"; "spotter table lists sizes and the empty line when none"; "measurement label: Exact report and Estimate (aerial/footprint) appear, with squares and pitch"; "inspection and notes appear"; "footer"; "map image: only with bytes".
  - `packages/db/test/claim-packet.test.ts`: "hail: the largest contour containing the property on the date of loss"; "spotter reports: only within 10 miles and on the day, largest first then earliest, at most 10"; "measurement: latest for the property with its label".
  - `apps/api/test/claim-packet.test.ts`: "POST builds a claim_packet stored file and GET streams the PDF"; "a rerun stores a second version and GET returns the latest"; "no map key: the PDF is still built without an image"; "with a map the static map is asked at most once, for the property point, and no network is used".
- **Replies update claims and draft adjuster appointments**
  - `apps/api/test/claims-replies.test.ts`: "hook sends claims-reply job only when claims text within 7 days and open claim"; "job saves claim number and insurer, events by agent, and makes a live note task"; "adjusterAt drafts a needs-approval create_appointment task with 60 minute end and the rep as userId"; "unavailable extraction (ScriptedLlm throws LlmUnavailableError) changes nothing"; "no text is sent by the job".
  - `apps/api/test/g1-inbound-order.test.ts`: "an inbound text from a known customer calls onClaimsReply once, in the same transaction, with the stored message"; "when onClaimsReply consumes the reply the hook answers 200 with no TwiML message body"; "%s from a known customer never reaches onClaimsReply" (STOP, HELP, START).
- **Staff agenda email without approval**
  - `apps/api/test/scheduler-agenda.test.ts`: "one email per member with the right visits in time order"; "no task is created"; "a second run the same day sends nothing new".
- **Moves respect crew availability**
  - `apps/api/test/scheduler-weather.test.ts`: "a busy next day for the installer is skipped"; "no clear day in two weeks: nothing to move, no task".
  - `packages/db/test/scheduler-weather.test.ts`: "includes own appointments and busy blocks; excludes canceled, other users and the excluded one".
- **Cross-tenant isolation**
  - `apps/api/test/claims.test.ts`: "another company cannot see or edit the claim (404)"; "a rep cannot see another rep's job's claim (404)".
  - `packages/db/test/claims.test.ts`: "another company sees none of the claims"; "the claim row belongs to the saving company".
  - `packages/db/test/follow-up-finder.test.ts`: "another company sees nothing" (leads and reviews).
  - `apps/api/test/scheduler-agenda.test.ts`: "a different company's visits never appear".
  - `apps/api/test/agents-api.test.ts`: "company B isolation: cross-tenant data is never counted; unknown agent is 404 for both".

## Browser
- **The agent cards live, approving a follow-up task with personal texts, the Claim section and packet, the weather move review**
  - `apps/web/e2e/more-agents.spec.ts`: "the three G1 agents start paused, Turn on Follow-up shows its rules, and Run now makes a plan to approve"; "the claim section saves insurer and claim number, then builds a claim packet with a Download link"; "a weather move review shows the new day and the reason, then Approve".
- **Accessibility (no serious or critical axe violations)**
  - `apps/web/e2e/a11y.spec.ts`: "agents window with the G1 cards has no serious accessibility violations"; "job window claim section has no serious accessibility violations"; "follow-up review with personal texts has no serious accessibility violations".
- **Phone**
  - `apps/web/e2e/phone.spec.ts`: "follow-up texts review fits the phone"; "Agents window with the G1 cards does not scroll sideways".
- **Component tests behind the screens**
  - `apps/web/test/g1-turn-on.test.tsx`: "the Agents window shows Turn on on each paused G1 card"; "shows the rules before turning on, and sends one request only on confirm"; "a paused %s offers Turn on and no Run now".
  - `apps/web/test/claim-section.test.tsx`: "shows the claim, its history, and no phone or email links"; "the build button posts and the download link appears"; "a packet already built shows the download link".
  - `apps/web/test/step-g1-registry.test.tsx`: "lists the four new types with a full kit".

## Acceptance items
- **The three agents are listed on A1 with real numbers**
  - `apps/api/test/agents-api.test.ts`: "a fresh company sees the three G1 agents paused and the launch agents not paused"; "a G1 agent with a row and no pause is on, and shows its seeded work"; "numbers come from seeded tasks and snapshots".
  - `apps/api/test/agents-rule-facts.test.ts`: "rulesFor gives the three G1 agents their sentences from the gathered facts".
  - `packages/shared/test/agent-rules.test.ts`: "default sentences and links" (claims and scheduler); "default sentences with reviews on" (follow_up).
  - `apps/web/e2e/more-agents.spec.ts`: "the three G1 agents start paused, Turn on Follow-up shows its rules, and Run now makes a plan to approve".
- **Each drafts only into R2 (the approval queue), except staff notices and claim fact updates from replies**
  - Drafts wait for approval: `apps/api/test/claims-replies.test.ts`: "adjusterAt drafts a needs-approval create_appointment task with 60 minute end and the rep as userId"; `apps/api/test/scheduler-no-show.test.ts`: "makes one needs-approval task with two times"; `apps/api/test/claims-nudges.test.ts` and the follow-up tests above make plans, and the handlers send only when the owner approves (`apps/web/e2e/more-agents.spec.ts`, Approve in the first and third tests).
  - The two allowed exceptions: `apps/api/test/scheduler-agenda.test.ts`: "no task is created" (staff agenda email); `apps/api/test/claims-replies.test.ts`: "job saves claim number and insurer, events by agent, and makes a live note task"; "no text is sent by the job".
- **Stop conditions and limits hold**
  - `apps/api/test/followup-daily.test.ts`: "a lead who texted yesterday, a lead with an appointment and a lost job make no plan"; "a claims text 2 days ago blocks the lead (spacing across agents)".
  - `apps/api/test/followup-proposals.test.ts`: "a %s proposal is never followed up" (signed, declined, replaced, expired, draft, ready); "a customer who texted yesterday is skipped"; "a lost job is skipped"; "after two texts the rep is asked to call once, and no third text is sent".
  - `apps/api/test/personal-texts.test.ts`: "a customer who replied 1 day ago is blocked as frequency and a reminder still goes"; "the per-claim cap blocks a fifth claims text because the log is read over the whole life of the claim".
  - `packages/shared/test/more-agents.test.ts`: the limit tests listed under Unit.
- **Review requests only with marketing consent**
  - `apps/api/test/followup-reviews.test.ts`: "consent none and express are skipped; attested and written are included"; "the step is marketing, kind review, dedupePrefix followup-review:2026-10-13, and the body ends with the STOP line".
  - `packages/db/test/follow-up-finder.test.ts`: "consent none and express are skipped; attested and written are returned".
  - `apps/api/test/personal-texts.test.ts`: "a review request to an express customer is blocked by the gate".
  - `packages/shared/test/g1-steps.test.ts`: "a review request must be marketing".
- **Claims texts never mention coverage or deductibles**
  - `packages/shared/test/claims-guard.test.ts`: "claimsGuard refuses".
  - `packages/shared/test/g1-steps.test.ts`: "a text about prices is refused with the exact message".
  - `apps/api/test/claims-nudges.test.ts`: "a draft failing the claims guard falls back to the template".
  - `apps/api/test/personal-texts.test.ts`: "a claims guard hit at send time blocks only that message".
  - `apps/api/test/claim-packet-pdf.test.ts`: "never mentions deductible or adjuster".
  - By hand, real models: the claims-text eval (see Gaps).
- **No message to an insurer or adjuster exists anywhere in code paths**
  - `apps/api/test/no-insurer-contact.test.ts` (a static scan of `apps/api/src`; no database): "no send path reads an adjuster phone or email"; "no send_personal_texts payload field carries an insurer or adjuster"; "the claims agent only addresses the homeowner"; "the scan finds the send paths it guards".
  - Older, narrower cousin: `apps/api/test/personal-texts.test.ts`: "no agent code uses an adjuster or insurer contact" (bans the four adjuster phone and email identifiers under `apps/api/src/agents/`).
  - Behaviour: `apps/api/test/claims-replies.test.ts`: "no text is sent by the job"; `apps/api/test/claim-packet-pdf.test.ts`: "footer" (the packet states that Roofline does not contact insurers).

## Gaps
- **Live model evals are by hand:** 30 follow-up texts and 20 claims texts drafted by the real model and graded (code checks plus a Haiku grade) are not in CI. They are the by-hand script of Task 18a (`npm run eval:agent-texts`, `scripts/eval-agent-texts.ts`); listed as "by hand, Task 18a" until its unit tests exist, and then they can be cited by name.
- **No live provider in CI:** real Twilio sends, MapTiler static maps and NWS hourly forecasts are not called. The end-to-end stack uses `FAKE_PROVIDERS` (scripted model with template fallback, fake SMS); the API tests use fakes and forecast fixtures. A first run against the real services is a manual step for launch.
- **D1 Task 14 continuation for claims replies (carry):** the claims reply hook is tested here with the Front Desk continuation faked or absent (`g1-inbound-order.test.ts`); the full path where Front Desk answers after the claims reply, including its short "Thanks, got it." text, waits for the d1 merge and is not covered.
- **Playwright is listed locally, proven only on CI:** the three `more-agents.spec.ts` tests and the new a11y and phone tests cannot run on the build machine (no Docker); their first real run is the CI E2E job (desktop and phone projects).
- **Rate and limit tests for `followUpAllowed`:** the pure rules are unit-tested in `packages/shared/test/more-agents.test.ts` and their effect at send time in `personal-texts.test.ts`, but there is no test that drives a full week of daily runs for one customer across all three agents.
- **Cross-tenant sweep:** `apps/api/test/isolation.test.ts` does not list the claim, claim packet or agent run routes; cross-tenant checks for G1 are the per-feature tests under Integration, not the shared sweep.
- **Static scan limits:** `no-insurer-contact.test.ts` reads source text, so it catches a send call that names the adjuster or insurer in the same file, not a recipient assembled from a stored value under another name. Two files (`routes/claims.ts`, `agents/claims/replies.ts`) and `agents/personal-texts.ts` (a message string) are on its explicit allow list, each with a reason.
- **Agenda email contents in the browser:** the staff agenda email and the in-app agenda are covered at the API level only; no Playwright test opens them.

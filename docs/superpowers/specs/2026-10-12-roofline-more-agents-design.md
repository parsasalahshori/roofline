# Roofline SaaS — Sub-project 7: Claims, Scheduler and Follow-up agents

- **Date:** 2026-10-12
- **Status:** written by Architect 2 under the owner's standing rule ("just build, take the recommended option"). Choices are recorded as **Decision: … (recommended because …)**.
- **Parent:** [Master design](2026-10-10-roofline-saas-design.md) §2 (agents draft, owner approves), §4 (next release), §5.3 (R2), §8 row 7, §9. Builds on F1–F3 (tasks, send gate, consent), C1 (jobs, stuck jobs, appointments, availability, Today), E1 (proposals, PDF, R2), S1 (storms, hail at a home, spotter reports), D1 (claim intakes, Front Desk texts, NWS daily forecast, `Llm` seam, guards) and [A1](2026-10-12-roofline-agents-screen-design.md) (cards, baselines, rules, pause, Run now).
- **Delivery:** one milestone, **G1**, one plan (`docs/superpowers/plans/2026-10-12-roofline-more-agents.md`).

---

## 1. Goal

Three drafting agents that take routine office work off the owner, each following the R2 pattern (draft → approve → run → results) and shown on the A1 screen:

1. **Claims:** keeps each insurance job's claim moving — tracks claim status, builds a **claim packet** PDF with the storm evidence and measurements, nudges the homeowner for the claim number and adjuster date, and puts the adjuster visit on the calendar.
2. **Scheduler:** keeps the calendar reliable — **tomorrow's reminders** to customers, the crew's agenda, **weather watch** that proposes moving installs before rain or wind, and rebooking no-shows.
3. **Follow-up:** keeps jobs from going quiet — follow-ups on unsigned proposals and unbooked leads, nudges to reps on stuck jobs, and **review requests** after installs.

**Every customer-facing action is a draft the owner or office approves**; staff-only notices (the crew's agenda, a nudge to a rep) go out without approval. **New agents start paused** (Decision 1).

**Not in G1:** contacting insurers or adjusters, telling homeowners what insurance will pay, supplements or Xactimate estimates, photo reports, standing approvals (owner item), outbound calls.

## 2. Shared pieces

- **Decision 1: the three agents start paused, with a "Turn on" on their A1 card that shows their rules first** (recommended because each texts customers on a schedule; the owner should opt in knowingly).
- **New step types** (in `shared/steps.ts`):
  - `send_personal_texts` (message): `{ purpose, messages: [{ customerId, jobId | null, body }] (1–100), dedupePrefix }` — each message its own text through the gate; preview lists every message (first 20 inline, "and 34 more" expandable); baseline `text_sent` (A1) or the agent-specific key.
  - `build_claim_packet` (internal): `{ jobId }` → PDF in R2; baseline `claim_packet` 30 min.
  - `create_appointment` (internal): `{ jobId, kind: 'adjuster' | 'inspection', start, end, userId, note }`; baseline `booking` 3.
  - `move_appointment` (internal): `{ appointmentId, start, end, userId }` (installs: all-day range); baseline `install_moved` 10.
- **Wording:** **Decision 2: the agents write each customer text with `claude-opus-5-5` (structured output, effort `low`, refusal fallbacks), from the job's facts and a per-kind instruction, then pass every text through D1's guards; templates are the fallback when the model is unavailable** (recommended because personal follow-ups read better than templates, cost about $0.003 each, and the owner reviews every one before it is sent). Drafting runs in the background (no latency target). Haiku 5.5 extracts claim numbers and dates from homeowner replies (§3.3).
- **Consent:** reminders, claim nudges and proposal follow-ups are **informational** (about the customer's own project; `express` consent); review requests are treated as **marketing** (Decision 9). The gate decides each text again at send time.
- **Inbound text order** (one hook each, in `hooks/twilio.ts`): STOP/HELP/START (F3) → S1 YES replies → **G1 claims replies** (§3.3) → D1 Front Desk.
- **A1 integration:** baselines `claim_packet` 30, `reminder_sent` 1, `install_moved` 10, `follow_up_sent` 2; rules sentences; Run now ("Check claims now", "Check tomorrow now", "Find follow-ups now"); pause honoured by each daily job.

## 3. Claims agent

### 3.1 Claim record

- **`claims`** (tenant, one per job): `insurer`, `claim_number`, `date_of_loss`, `status (not_filed|filed|adjuster_scheduled|inspected|approved|partly_approved|denied|supplement_requested|closed)`, `adjuster_name`, `adjuster_phone`, `adjuster_email`, `adjuster_appointment_id`, `deductible_cents`, `notes`, `status_changed_at`. Created from D1's `claim_intakes` (promoted on first save) or by hand in the job window's new **Claim** section.
- Status changes by people (job window) or by the agent from homeowner replies (shown in the feed, editable). Pipeline: a claim reaching `approved` suggests moving the job to Proposal (C1 stage rule hint, not automatic).

### 3.2 Claim packet

- **Decision 3: a claim packet PDF for the homeowner and rep, never sent to the insurer by Roofline** (recommended because the packet helps the homeowner file and the adjuster visit go well, while contacting insurers on a homeowner's behalf is public-adjusting, which most states license — contractors may not negotiate claims). Contents: cover (homeowner, address, claim number, insurer, date of loss); **storm evidence** — S1's radar-estimated hail size at the home on the date of loss ("Radar-estimated hail up to 1.75 inches (NOAA MRMS)"), the NOAA spotter reports within 10 miles that day, a static swath map image (MapTiler static API — Decision 3a, ~$0 within the existing plan's quota); **measurements** from E1 (estimate or exact, labeled); inspection date and notes; D1 claim intake notes. Rendered with C1's PDF renderer, stored in R2, downloadable from the job window and sendable to the homeowner as a link inside a `send_personal_texts` step.
- Drafted when a claim is created on a storm job with an inspection done, or on "Build claim packet".

### 3.3 Nudges and replies

- **Daily 10 AM (company time):** one Claims task with up to three kinds of steps:
  - `not_filed` for 3+ days after the inspection → text: ask whether they've filed and to reply with the claim number and insurer;
  - `filed` without an adjuster date for 5+ days → ask for the adjuster visit date;
  - adjuster visit passed 7+ days ago without a status → ask how the adjuster visit went / whether they got the decision letter.
  - Max one claims text per customer per 4 days; max 4 per claim.
- **Replies:** a homeowner text within 7 days of a claims text goes to Haiku 5.5 extraction (`{ claimNumber?, insurer?, adjusterAt?, decision? (approved|partly|denied) }`, structured output). Extracted facts **update the claim immediately** (a `live` task "Claims noted claim number 0451-22" — reversible in the job window), and an adjuster date drafts a **`create_appointment`** step (kind adjuster, assigned to the job's rep, the rep's availability checked) for approval. The reply also continues to D1 Front Desk unless the extraction fully answered it (Front Desk then sends a short "Thanks, got it." through the gate).
- **Decision 4: claims texts never discuss coverage, amounts owed or what to tell the insurer** (guards from D1 plus a claims guard list: "deductible waived", "we'll cover your deductible", "upgrade paid by insurance") (recommended because deductible-waiving and coverage statements are illegal or risky in many states (e.g. TX, FL, CO)).

## 4. Scheduler agent

- **Tomorrow's reminders (daily 3 PM):** one task "Reminders for tomorrow (8 texts)" with a `send_personal_texts` step for every appointment tomorrow with a customer (inspection, install, adjuster): "Hi Maria, reminder: Sam from Acme Roofing will be at 812 Oak St tomorrow between 10 and 11. Reply C to confirm or call us to change." (D1's "C" handling confirms.) Expires at 9 PM the same day.
- **Crew agenda (no approval):** at 6 PM each rep/crew member with appointments tomorrow gets an email (and in-app) agenda: times, addresses, customer phone, notes, links. **Decision 5: staff agenda emails need no approval** (recommended because they don't leave the company and are what a scheduler would do anyway).
- **Weather watch (daily 6 AM and 2 PM):** installs in the next 3 days where the NWS hourly forecast at the home shows **precipitation probability ≥ 60% or wind gusts ≥ 25 mph during work hours** (company settings) → a task "Rain on Thursday — move 2 installs?" with `move_appointment` steps to the **next workday that is forecast clear and free for the assigned crew** (C1 availability, all-day) and a `send_personal_texts` step telling each customer the new date. **Decision 6: the agent proposes, never cancels; the crew lead's own call wins** (recommended because roofers judge weather by more than a forecast). The forecast uses D1's NWS `daily` plus a new `hourly` read (free).
- **No-shows:** an appointment marked `no_show` → a draft text offering two new times (C1 availability).

## 5. Follow-up agent

- **Daily 9 AM**, one task "Follow-ups for today (6)":
  - **Unsigned proposals:** E1 proposals `sent`/`viewed`, not signed, 3 days after sending (or 2 days after the last view) → a follow-up text; a second after 4 more days; then stop and put "Call Maria about her proposal" on the rep's Today (C1 next step). Max 2 texts per proposal.
  - **Unbooked leads:** Lead jobs with no appointment 2 days after creation → a text offering inspection times (C1 availability, two options).
  - **Stuck jobs** (C1's stuck rule): **no text** — a nudge to the rep (in-app + their Today) "No activity on the Lopez job for 14 days." (staff-only, no approval).
  - **Review requests:** installed jobs 3 days after the install completed, once per job → a review request with the company's review link (Settings).
- **Decision 7: follow-ups stop the moment the customer replies, signs, books, or says no** (any inbound text on the job's customer in the last 3 days, a signature, an appointment, or the job marked Lost) (recommended because nothing irritates a homeowner more than a follow-up after they've answered).
- **Decision 8: at most one Follow-up text per customer per 3 days across all kinds, and nothing to customers with a Storm Scout text in the last 3 days** (recommended because the agents share one customer).
- **Decision 9: review requests are treated as marketing** — only to customers with `attested`/`written` consent, with the company name and "Reply STOP to opt out" (recommended because soliciting reviews is promotional under a cautious reading of the TCPA; lawyer item to confirm).
- **Decision 10: no review gating** — every completed job gets the same request (recommended because Google's and the FTC's rules forbid asking only happy customers).

## 6. Data (one migration pair)

- `claims` (tenant, §3.1, unique `(company_id, job_id)`); `claim_events` (status history: `claim_id`, `from`, `to`, `by (user|agent)`, `at`).
- `follow_up_log` (tenant): `customer_id`, `job_id`, `kind (proposal|lead|review|claims|reminder|no_show)`, `n`, `message_id`, `at` — dedupe and the per-customer limits.
- `company_settings` gains `claims_nudge_days int[]` (`{3,5,7}`), `weather_rain_pct int` (60), `weather_gust_mph int` (25), `reminder_hour int` (15), `followup_days int[]` (`{3,4}`), `lead_followup_days int` (2), `review_link text`, `review_delay_days int` (3), and per-kind switches (`followup_reviews bool` true, `followup_leads bool` true, `followup_proposals bool` true).
- `appointments` gains `moved_by_task_id` (nullable).
- `STORED_FILE_KINDS` gains `claim_packet`.

## 7. Screens

- **Job window → Claim section** (C1 job window): status chip, fields, timeline of claim events, "Build claim packet", packet download.
- **Agents (A1):** the three cards switch from "Coming soon" to live, with rules sentences, Run now and pause; **Claims page** adds a claims board (columns by status).
- **R2 review** previews for the four new steps (each personal text listed with its recipient; moves show old → new date with the forecast reason).
- **Settings → Agents:** the values behind each rule (days, thresholds, reminder hour, review link).

## 8. Costs

- Opus 5.5 drafting ≈ $0.003 per text (≈ 400 input incl. cached instructions, ≈ 120 output + low-effort thinking); Haiku extraction ≈ $0.0002 per reply. A busy roofer (40 drafted texts a day) ≈ **$4/month** in model use. Texts are metered as SMS segments (F3). NWS free. MapTiler static images within the existing plan.

## 9. Testing and acceptance

- **Unit:** finder rules (days, limits, stop conditions, cross-agent spacing), weather thresholds over forecast fixtures, claim status transitions, guards incl. the claims list, extraction parsing.
- **Integration:** each daily job with seeded jobs drafts the right task and steps; pause skips; Run now; texts through the gate with the right purpose; packet PDF contents (hail line, spotter rows, measurement label); replies update claims and draft adjuster appointments; staff agenda email without approval; moves respect crew availability; cross-tenant isolation.
- **Evals (by hand, real models):** 30 drafted follow-ups and 20 claims texts graded for: no prices/coverage, the job's real facts only, ≤ 300 characters, plain and polite (code checks + Haiku grader).
- **Browser:** approving a follow-up task with personal texts, the Claim section and packet, the weather move review, the agent cards live, a11y, phone.
- **Acceptance (G1):** the three agents are listed on A1 with real numbers; each drafts only into R2 (except staff notices and claim fact updates from replies); stop conditions and limits hold; review requests only with marketing consent; claims texts never mention coverage or deductibles; no message to an insurer or adjuster exists anywhere in code paths.

## 10. Owner to-dos

- **Lawyer:** the Claims agent's boundaries (public-adjuster licensing, deductible rules by state), whether review requests need marketing consent, and the claim-nudge wording.
- **Decide later:** whether to offer **standing approvals** (e.g. "send tomorrow's reminders without asking") — a change to master §2's "agents draft, owner approves".
- **Each roofer** adds their Google review link (in-product; not an owner task).
- **MapTiler:** confirm static-map images are included in the plan's quota.

## 11. Decisions index

1 start paused · 2 Opus-written texts with guards, templates as fallback · 3 claim packet for homeowner and rep, never to insurers (3a static map image) · 4 no coverage/deductible talk · 5 staff agendas without approval · 6 weather moves are proposals · 7 stop on any reply · 8 one follow-up per 3 days, spaced from storm texts · 9 review requests as marketing · 10 no review gating.

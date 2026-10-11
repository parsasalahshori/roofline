# Roofline SaaS — Master Design

- **Date:** 2026-10-10
- **Status:** approved in conversation; written spec waiting for owner review
- **Scope:** the whole product. Each sub-project in §8 gets its own spec, then its own implementation plan.
- **Sub-project specs:** [Foundation](2026-10-10-roofline-foundation-design.md) (first). The rest are written when their turn comes.

---

## 1. Goal

- **What:** turn Roofline from a single-company local estimator (v1) into a **SaaS sold to many roofing companies**. It replaces their CRM and adds four AI features modeled on a competitor demo:
  1. **Storm Scout**: hail swath map, then reaching customers and homes in the path.
  2. **Estimator**: instant roof estimate, then a Good/Better/Best proposal sent by text, then e-sign.
  3. **Front Desk**: an AI that answers every call and text.
  4. **Agents screen**: what the AI team did, and hours saved.
- **Two tracks, one product:**
  - **Track A:** redo the clunky v1 UX on a new foundation.
  - **Track B:** add the new features. Everything shares one shell, one design system and one approval pattern.
- **Reference:** the competitor "Ironclad OS" (`roofing-os-demo.vercel.app`) is a **front-end-only demo with sample data**. Its own page says every name, address and number is sample data. We build for real what it fakes.

## 2. Users and success criteria

- **Customer:** US residential roofing companies, typically 2–20 people, doing a **mix of storm/insurance and retail** work.
- **Primary user:** the **owner/GM at a desk**, who is non-technical. Design for them first.
- **Other logins:**
  - **Office:** calls, calendar, proposals.
  - **Sales rep:** mostly on a phone; their own leads, jobs and routes.
  - Each role gets its own home.
- **Success = few clicks, plain words, one flow.** Automated browser tests enforce these limits:
  - **Storm plan:** from "storm detected" to approved in **2 clicks**.
  - **Proposal:** from a typed address to "sent to homeowner" in **3 clicks or fewer**.
  - **Any common task:** reachable in **3 clicks or fewer** from the home screen.
  - **No jargon on screen:** no vendor names (except on the Connections page), no raw status codes, no "JSON", "API", "sandbox" or "env" in the UI.
- **Launch goal:** **full launch**. That means self-serve sign-up, billing, onboarding, and the three launch agents working for any roofer.

## 3. Decisions

### 3.1 Made by the owner (brainstorm, 2026-10-10)

| Area | Decision |
|---|---|
| Product | Multi-company SaaS; full launch (self-serve sign-up, billing, onboarding) |
| Primary user | Owner/GM at a desk; roles: owner, office, rep |
| Market | Mixed storm/insurance and retail roofers |
| CRM role | **Replaces** their CRM: customers, jobs, proposals and calendar, with an import from the old tool |
| Agent autonomy | **Agents draft, owner approves.** Exception: Front Desk on a live call may book inspections, answer job questions, take claim details, and text back missed callers |
| Hail data | Free NOAA MRMS **MESH** radar grid |
| Homes in path | The roofer's customers **plus every home** from free building/address data. **No owner names** |
| Storm ads | The roofer connects **their own** Google Ads and Meta accounts; Roofline launches on approve |
| Text consent | When importing, the **owner confirms** that imported customers agreed to texts. The confirmation is recorded with who confirmed it and when |
| Measuring | **Instant estimate** (footprint × pitch) plus a one-click **exact EagleView report**, billed through Roofline |
| Homeowner page | Pick Good/Better/Best, see financing, **e-sign**. **No deposit or payments** |
| Calls | **AI answers every call** (the business number forwards to Roofline) and transfers to a person when needed |
| Calendar | **Built-in calendar plus two-way Google/Outlook sync** |
| Launch agents | **Storm Scout, Estimator, Front Desk.** Claims, Scheduler and Follow-up come in the next release and show as "coming soon" |
| Pricing | **Monthly plan plus usage** (AI minutes, texts, exact reports at cost plus markup) through Stripe |
| Onboarding | **Guided setup checklist.** The map is usable in about 2 minutes; each agent unlocks when the setup steps it needs are done |
| Layout | **A2 "map desktop":** a full-screen map background, a labeled dock, **one big centered window at a time** |
| Look | **S1 warm and friendly:** cream background, amber accent, soft cards, big numbers |
| Approvals | **R2:** one review screen per draft (everything on, each step can be turned off or edited) and **one Approve button** |

### 3.2 Picked by Claude as the recommended default (owner said "always do the recommended")

| Area | Decision |
|---|---|
| Code approach | **Rebuild the foundation; port the proven v1 parts** (pricing engine + tests, EagleView clients, NOAA spotter reports, PDF). We did not patch v1 (single-tenant SQLite) or build on a white-label CRM (we would lose control of the UX) |
| Repo | The Roofline folder is its own git repo (baseline commit `7b65c77`). The v1 code moves to `v1/` as a runnable reference; new code goes in `apps/` and `packages/` |
| Home screen | Map with territory, customer and job pins, and the latest swath. A **"Today" window opens once per day** at first login (approvals plus today's schedule) |
| Phones | Reps get a phone layout: full-screen pages and a bottom tab bar (My day, Map, Jobs, Calendar). The homeowner page is phone-first |
| Financing | A monthly-payment **estimate** from an APR and term the roofer sets once. Real lender integrations come later |
| E-sign | **Built in** (ESIGN/UETA consent, audit trail, tamper-evident signed PDF). No third-party e-sign provider |
| Call guardrails | The AI never quotes prices and never promises insurance coverage. It takes a message or creates a task instead |
| Always-on safety | STOP handling, quiet hours, frequency caps, AI and recording disclosure. These cannot be switched off |
| "Likely damaged" | Radar hail of **1 inch or more** (owner can change this). Roof age is used only when known |
| Meta limits | If Meta classifies roofing ads as "Housing", Meta storm ads use its 15-mile minimum radius. Google ads stay street-level (1 km circles) |

## 4. Scope

- **In for launch:**
  - Foundation
  - Core CRM screens
  - Estimator plus the homeowner page
  - Storm Scout
  - Front Desk
  - Agents screen
- **Next release:** the Claims, Scheduler and Follow-up agents.
- **Out (not planned):**
  - Payments or deposits from homeowners
  - Owner names or mailing lists (paid parcel data)
  - Paid hail vendors
  - Real lender sign-ups
  - White-label or agency ad management
  - The Node/BuildCLI command-line tools (they stay in `v1/` only)
  - Photo-based damage diagnosis
  - AI-measured roof facets from imagery (instant estimates are footprint × pitch; exact facets come from EagleView)

## 5. Experience system

### 5.1 Shell (layout A2)

- **Background:** a full-screen live map showing the service area, customer pins, open-job pins colored by stage, and the latest storm swath (last 7 days). Clicking a pin opens that customer or job.
- **Top bar:**
  - logo
  - **"N need your OK"** pill (amber; hidden when zero)
  - "N agents working" status
  - today's weather
  - search (⌘K)
  - user menu (settings, billing, team, sign out)
- **Dock (bottom, labels under every icon):**
  - **Storm · Front Desk · Estimator · Jobs · Calendar · Agents**
  - Red badges mean "something needs you" in that app.
- **Windows:**
  - Clicking a dock app opens **one large centered window** over the map. Opening another replaces it.
  - ✕ or Esc closes it. Browser Back closes it.
  - Every window and sub-view has its **own URL**, so links from texts, emails and notifications open the right window.
- **Phone (under 768px):** windows become full-screen pages. The dock becomes a bottom tab bar (My day, Map, Jobs, Calendar; "More" holds the rest).

### 5.2 Look (S1)

- **Tokens:** cream background, near-black warm text, amber primary buttons, soft shadows, 12–14px corner radius, big tabular numbers on stat cards.
- **Type:** body 14px, **minimum 12px anywhere** (v1 had 6–9px text).
- **Hail color scale:** yellow → orange → magenta by size. It is used only for hail.

### 5.3 Approvals (R2) — one pattern for every agent

- **What a draft is:** every agent output that would leave the building (texts, ads, proposals, routes, paid reports) is a **draft task**.
- **"N need your OK" window:** lists every draft, from every agent, newest first.
- **Review screen:**
  - **Every step**, each with a **preview** of exactly what goes out: message text, recipients and count, send time, ad creative and area, **maximum spend**.
  - Each step has an **on/off switch** and **Edit**.
  - One **Approve** button that counts the steps ("Approve 3 steps") and a **Not now** button.
- **After approving:** progress and results appear in the same window (sent, delivered, replies, inspections booked).
- **Who can approve:**
  - Steps that **spend money** (ads, exact reports): **owner only**. The owner can delegate.
  - **Messages** (texts, proposals) and **internal** steps (routes): **owner or office**.
- **Partial approval:** when an office user approves a plan that includes a spend step they can't approve, the rest runs right away and the spend step waits in the owner's "need your OK". Nobody is blocked.

### 5.4 Plain-English rules

- **Glossary:**

  | Instead of | Say |
  |---|---|
  | EagleView report | "Exact roof report" |
  | Instant measurement | "Estimate" |
  | `draft` | "Waiting for your OK" |
  | Data source | "Radar-estimated hail" |

- **Errors** say what happened and what to do next. They never show codes.
- **Banned strings** in UI text are checked by a test: `JSON`, `API`, `sandbox`, `env`, `webhook`, raw enum values.

## 6. Architecture

- **Web app:** React + TypeScript + Vite.
  - React Router gives real URLs.
  - TanStack Query handles server data.
  - CSS Modules use the S1 design tokens.
- **Map:** **MapLibre GL**, a WebGL vector map that is smooth with swath heatmaps and thousands of home dots. Basemap and satellite come from **MapTiler**.
- **Geocoding:** **Geocodio** (US addresses, results may be stored). Google geocoding is not used, because Google's terms forbid showing its results on non-Google maps.
- **API server:** Node + TypeScript + Express 5, validated with zod (v1 patterns kept).
  - It runs on an **always-on host (Render web service plus background worker)**, because live calls need long-held WebSocket connections. Serverless does not fit.
- **Database:** **Postgres with PostGIS** (managed, on Supabase Postgres; the Supabase auth product is not used).
  - Every row has `company_id`.
  - Tenancy is enforced in the app's data layer **and** by Postgres row-level security as a backstop.
- **Background work:** **pg-boss** job queue in Postgres. It runs every agent step, with retries and schedules.
- **Hail worker:** a small **Python + GDAL** service.
  - Every 30 minutes it pulls MRMS `MESH_Max_1440min` from NOAA's public S3 bucket (`noaa-mrms-pds`).
  - It writes swath contour polygons (1", 1.5", 1.75", 2", 2.5") and a per-home hail value into PostGIS.
- **AI:** **Claude Opus 5.5** (`claude-opus-5-5`) for every agent.
  - **Drafting** (storm plans, proposal texts) uses structured outputs.
  - **Front Desk** uses tool use with `strict: true` at **low effort** for speed. Its latency is measured in the Front Desk spec before deciding whether a cheaper model is acceptable on calls; that is the owner's call.
  - Server-side refusal fallbacks are enabled.
  - Stable system prompts are cached.
- **Outside services:**

  | Purpose | Service |
  |---|---|
  | Calls and texts | **Twilio**: Voice plus ConversationRelay for the AI calls; Messaging with each roofer registered as its own 10DLC brand through Twilio's ISV flow |
  | Ads | **Google Ads API** and **Meta Marketing API**, using each roofer's own accounts (OAuth) |
  | Calendars | **Google Calendar** and **Microsoft Graph** (OAuth, two-way sync) |
  | Billing | **Stripe Billing** (plans plus metered usage) |
  | Exact reports | **EagleView** (ordered on Roofline's account, re-billed) |
  | Weather forecast | **NWS api.weather.gov** (free, public domain) |
  | Login and notification email | **Postmark** (transactional email) |
  | Files | **Object storage** (S3-compatible: Cloudflare R2) for PDFs, signed proposals and call recordings |

## 7. Data (core entities)

The schema is owned by the Foundation spec; feature specs add their own tables.

| Entity | Purpose |
|---|---|
| `companies`, `users`, `memberships` (role) | Tenancy and logins |
| `customers` | People; phones, emails, **text-consent record**, do-not-contact |
| `properties` | Address, map point, time zone, building footprint, year built (when known) |
| `jobs` | Pipeline: Lead → Inspection → Proposal → Won → Installed (or Lost); source; value; assigned rep |
| `appointments` | Inspection, install or adjuster visit; links to outside calendar events |
| `measurements` | Estimate or exact; area, pitch, sections, outline |
| `proposals` | Three options, each with a frozen price snapshot; financing; private homeowner link; signature record |
| `storms`, `storm_hits` | Swath polygons; home and hail size |
| `conversations`, `messages`, `calls` | Every text and call, with transcript, recording and summary |
| `agent_tasks`, `agent_task_steps` | **Drafts, approvals, runs and results.** Powers the "need your OK" pill, the activity feed and hours saved |
| `ad_campaigns` | Platform, outside ID, target areas, budget, spend |
| `usage_events` | AI minutes, text segments, reports, registration fees, sent to Stripe |
| `integrations` | Encrypted OAuth tokens and keys per company |
| `activities` | Timeline for any customer or job, not only quotes as in v1 |
| `audit_log` | Who did what, with before/after |

## 8. Sub-projects (build order)

Each sub-project gets its own spec, then a plan, then implementation, and ships before the next starts.

| # | Sub-project | Delivers | Size | Depends on |
|---|---|---|---|---|
| 1 | **Foundation** | Tenancy, logins and roles; sign-up; Stripe plans and usage; setup checklist; A2 shell and S1 kit; **approval queue and agent activity log**; **send gate**; customers, properties and jobs; CSV import with consent confirmation; **texting registration starts at sign-up** | L | — |
| 2 | **Core CRM screens** | Jobs pipeline window; customer and job page with timeline; built-in calendar with Google/Outlook two-way sync; ⌘K search; pricebook (ported); PDF (ported) | M | 1 |
| 3 | **Estimator + homeowner page** | Address → building outline → **instant estimate** → Good/Better/Best from tier templates (set up once) → draft text → R2 approve → homeowner page (pick an option, financing estimate, **e-sign**) → job moves to Won. "Get exact report" orders EagleView and re-prices | L | 1, 2 |
| 4 | **Storm Scout** | MESH worker → swath → homes and customers in the path → **storm plan draft** (texts, door-knock routes, ads) → R2 → run → results (replies, inspections) | L | 1, 2, 3 |
| 5 | **Front Desk** | Twilio number plus forwarding setup; voice AI with tools (find caller, job status, book inspection, take claim details, forecast, transfer); missed-call text-back; spam blocking; call log with recording, transcript and summary; text inbox | L | 1, 2 |
| 6 | **Agents screen** | One card per agent (tasks today, success rate, hours saved, mini chart); activity feed; plain-English rules per agent; "Run now"; handoff view; "coming soon" cards for Claims, Scheduler and Follow-up | S–M | 1, 3–5 |
| 7 | **Next release** | Claims, Scheduler, Follow-up agents | — | 6 |

- **Why Estimator comes before Storm Scout:** Storm Scout's results (booked inspections) become proposals, and the Estimator reuses the most v1 code, so it ships value soonest.

## 9. Cross-cutting rules

### 9.1 Send gate (one gate for everything outbound)

Every text, outbound call or ad launch passes **one service** that decides **send now**, **schedule for later**, or **block (with a reason)**, and records the decision.

- **Consent:**
  - Marketing texts (storm check-ins, offers) need a consent status of `attested` or `written`.
  - Informational texts (appointment confirmations, a proposal the customer asked for, missed-call text-back) need prior express consent: the customer gave the number for this purpose.
- **Opt-out:**
  - STOP (and its variants) opts the number out for that company. HELP replies with company info.
  - Opt-outs are honored on every channel and every agent.
- **Quiet hours:**
  - 8 am–9 pm in the **recipient's** local time (taken from the property's time zone).
  - In FL, OK and MD: 8 am–8 pm and at most 3 messages per 24 hours.
  - Texts outside the window are scheduled for the next allowed time.
- **Caps:**
  - At most **2 marketing texts per person per 7 days** (company-adjustable down, never up).
  - Never the same storm message twice to the same person.
- **Content:** marketing texts must include the company name and opt-out wording.
- **Registration:** no texts until the company's 10DLC campaign is approved.
- **Spend:** an ad launch never exceeds the approved maximum, and daily budgets are capped.

### 9.2 AI guardrails

- **Front Desk:**
  - It opens every call by saying it is a virtual assistant and that the call is recorded.
  - It may do only the four allowed live actions.
  - It transfers to a person on request or when something is urgent (active leak, injury, angry caller).
  - It never quotes prices and never promises insurance coverage.
- **Drafting agents:** they produce structured drafts only. **No outbound effect happens without an approved task**, except the four live Front Desk actions and missed-call text-back.
- **Labels:** "Estimate" stays on every price until an exact report replaces it. Hail is always "radar-estimated".

### 9.3 Security and tenancy

- **Isolation:** one roofer can never read or change another's data. API tests and row-level-security tests prove it.
- **Secrets:**
  - OAuth tokens and keys are encrypted at rest (AES-256-GCM, master key from the host's secret store).
  - Provider calls happen only on the server. The one exception is map tiles, which load in the browser with a public MapTiler key that only works from Roofline's domains.
- **Webhooks:** Twilio, Stripe, Google and Meta webhooks verify their signatures. A webhook payload is data, never instructions.
- **Audit:** every approval, edit, setting change, import and consent confirmation is recorded.

### 9.4 Reliability

- **No silent failures:** outside-service errors retry with backoff. After retries run out, the task shows **"Needs attention"** with a plain-English reason and a retry button.
- **Idempotency:** every agent step has an idempotency key, so a retry never double-texts, double-orders or double-launches.

## 10. Accounts and approvals needed (some take weeks — start during Foundation)

| Item | Why | Lead time / note |
|---|---|---|
| Anthropic API organization | All agents | Same day |
| Twilio account set up for ISV / A2P 10DLC, plus Roofline's own brand | Texting and calls for every roofer | Brand and campaign review about 10–15 days per roofer (research, Oct 2026); privacy-policy and terms URLs required |
| Stripe account | Billing | Days |
| Google Cloud project: OAuth consent screen verification (Calendar, Ads scopes) and Google Ads API access | Calendar sync, storm ads | Verification can take weeks; unverified apps are capped at 100 users |
| Meta developer app: Business Verification and Advanced Access for `ads_management` | Storm ads | Days to about 2 weeks |
| Microsoft Entra multi-tenant app plus publisher verification | Outlook calendar sync | Days |
| **EagleView partner/integration agreement** | Ordering on Roofline's account and re-billing roofers needs a commercial agreement | Commercial negotiation |
| MapTiler and Geocodio accounts | Map, satellite, geocoding | Same day |
| Domains: app domain, a **branded short-link domain** for texts, an email sending domain | Deliverability (carriers filter public link shorteners) | Days |
| **Lawyer review** | Terms of service (the owner's consent confirmation shifts texting liability to the roofer), privacy policy, e-sign consent, call-recording disclosure, TCPA practices | Before launch |

## 11. Testing strategy

- **Unit:**
  - pricing (v1 tests ported)
  - send-gate rules (consent, STOP, quiet hours including FL/OK/MD, caps, dedupe)
  - Good/Better/Best tier derivation
  - financing math
- **Integration:**
  - API against a real Postgres + PostGIS (Testcontainers)
  - **cross-tenant isolation tests** on every resource
  - fake versions of Twilio, Stripe, Google, Meta, EagleView and MapTiler/Geocodio
- **Scripted calls (Front Desk):** transcript-driven scenarios with a pass rubric: booking, job question, claim intake, spam, transfer, "what's my price?", angry caller.
- **Hail worker:** a stored MESH file from a real past storm, with expected contour areas and a fixture set of homes inside and outside the swath.
- **Browser end-to-end (Playwright):** the main flows on desktop and phone sizes, with **click counters asserting the §2 limits**.
- **UI checks:**
  - no font-size below 12px
  - banned-word scan of UI strings
  - keyboard navigation (Esc, focus trap, tab order) on windows

## 12. What carries over from v1

| v1 piece | Fate |
|---|---|
| `shared/pricing.ts` and `tests/pricing.test.ts` | **Ported** into `packages/shared`. Good/Better/Best runs `calculateQuote` once per tier |
| `server/providers.ts` EagleView legacy client and normalization | **Ported** into the Estimator |
| `server/eagleview-sandbox.ts` (Property Data v2 OAuth client) | **Ported** for development and testing |
| `server/storms.ts` NOAA SPC reports | **Ported** as a "spotter reports" map layer next to the MESH swath |
| `server/pdf.ts` | **Ported and extended** (three options, signature page) |
| `server/jobs.ts` idempotent order → draft flow | **Pattern kept**, re-implemented on pg-boss |
| UI, SQLite store, single-admin auth, CLI | **Replaced**; stays runnable in `v1/` as a reference |

## 13. Research notes (2026-10-10, carried into feature specs)

- **Google Solar API is not usable:** its terms limit use to energy-system workflows, so it can't power roofing proposals.
- **Ironclad OS is sample data only:** front-end only, no vendor calls.
- **MESH:**
  - about 1 km grid
  - the 24-hour maximum product is rewritten every 30 minutes, about 8 minutes after valid time
  - the archive starts 2020-10-14
  - it is calibrated to the 75th percentile of observed sizes and can underestimate, so it is labeled "radar-estimated"
- **Google Ads:** radius targeting with a 1 km minimum and no polygons, so a swath is covered with circles. Google's housing policy bans ZIP-code targeting.
- **Meta:**
  - `custom_locations` radius 0.63–50 miles
  - the Housing special ad category forces a 15-mile minimum, with no ZIP targeting and no age/gender targeting
  - whether roofing counts as Housing is unconfirmed
- **TCPA:** a storm check-in that offers an inspection is **marketing**, so treat prior express written consent as required. Customers may revoke consent "by any reasonable means".
- **Call recording:** all-party consent states include CA, FL, IL, MD, MA, MT, NH, PA and WA, so disclose on every call.
- **Inbound AI calls:** generally not covered by the 2024 FCC AI-voice ruling, which concerns outbound calls. Utah requires disclosing AI when asked; we always disclose.
- **Measurement reports:** EagleView costs about $18–105 per report, with turnaround from hours to 3 business days; it has a REST order/status/retrieve API. Hover needs on-site photos, so it is not an instant aerial option.

## 14. Feature-spec questions already assigned

These are deliberately decided in each sub-project's spec, not here:

- **Core CRM:** pipeline stage rules and the calendar availability model (work hours, travel buffers).
- **Estimator:**
  - the instant-pitch method (default pitch by region and age versus lidar)
  - tier template contents
  - homeowner page layout
  - e-sign record format
- **Storm Scout:**
  - door-knock route algorithm and rep assignment
  - ad creative generation
  - covering a swath with Google circles
  - the Meta Housing fallback
- **Front Desk:**
  - model latency measurement and model choice
  - transfer rules
  - spam detection
  - forwarding setup instructions per carrier
- **Agents screen:** the hours-saved formula (default minutes per task type × the company's hourly rate, default $28/hr).

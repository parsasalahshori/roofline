# Roofline SaaS — Sub-project 1: Foundation

- **Date:** 2026-10-10
- **Status:** written; waiting for owner review
- **Parent:** [Master design](2026-10-10-roofline-saas-design.md). §3 there lists every decision this spec relies on.
- **Delivery:** three milestones, **F1 → F2 → F3**. Each gets its own implementation plan and is usable and testable on its own.

---

## 1. Goal

Build the base that every later feature plugs into:

- **Multi-company tenancy**, logins and roles.
- **The approval queue** (drafts → approve → run → results), which all agents use.
- **The send gate**: the single gate for everything outbound.
- **Core customer, property and job data**, plus CSV import with a recorded consent confirmation.
- **The A2 shell and S1 design kit**: map desktop, labeled dock, one big window at a time, real URLs.
- **Self-serve sign-up, Stripe billing with usage metering, and the setup checklist.** Texting registration starts at sign-up, because carriers take 10–15 days.

**Not in Foundation:**

- pipeline, customer page and calendar screens (Core CRM)
- proposals and pricebook screens (Core CRM and Estimator)
- any agent's actual logic

Foundation ships stand-in example tasks so the approval flow can be tested end to end.

## 2. Repo layout

The repo is already initialized; the baseline commit `7b65c77` is v1.

```
roofline/
  v1/                 # current app moved here unchanged; still runs (npm start inside v1/)
  apps/
    web/              # React 19 + Vite + TypeScript (shell, windows, design kit)
    api/              # Express 5 + TypeScript (REST, webhooks, auth)
    worker/           # pg-boss worker process (same codebase as api, separate entry)
  packages/
    shared/           # zod schemas, types, pricing engine (ported from v1/shared/pricing.ts)
    db/               # Drizzle schema, migrations, tenant-scoped repository layer, RLS policies
    send-gate/        # outbound decision engine (pure functions + provider adapters)
    ui/               # S1 tokens + components (CSS Modules)
  services/
    hail/             # (Storm Scout) Python + GDAL; placeholder dir only in Foundation
  docs/
```

- **Workspaces:** npm workspaces; Node 22.
- **One `tsconfig` base**, with strict mode on.
- **Database:** Drizzle ORM plus drizzle-kit for migrations. PostGIS columns use Drizzle custom types.
- **Hosting:**
  - Render: one web service (`api`, which also serves the built `web` app) and one background worker (`worker`).
  - Managed Postgres 16+ with PostGIS on Supabase Postgres (the database only, not Supabase auth).
- **Environments:** `dev` (local Docker Postgres), `staging` and `prod`. Secrets live in the host's secret store; `.env` is for local dev only.

## 3. Milestone F1 — Platform core (API, data, queue, send gate)

### 3.1 Tenancy

- **Every table that holds customer data has `company_id uuid not null`.** These are the "tenant tables": customers, properties, jobs, activities, agent tasks and steps, messages, opt-outs, integrations, usage events, imports, setup items, audit log, company settings, and everything later features add.
- **Global tables** are not tenant-scoped, because they are read before a company is known: `users`, `sessions`, `memberships`, `invites`, `companies`, `company_phone_numbers`, `texting_registrations`, `webhook_events`.
- **App layer:** all tenant data access goes through `packages/db` repositories that **require a `TenantContext {companyId, userId, role}`**. There is no raw query path from route handlers.
- **Two database roles:**
  - **`app_tenant`** is used for all request work after the session resolves the active company.
    - It has access only to tenant tables. It sees member names through a `company_members` view filtered to the current company.
    - RLS is enforced. It is not the table owner and has no `BYPASSRLS`.
  - **`app_system`** is used only by functions in `packages/db/system/`:
    - **auth:** users, sessions, memberships, invites, and the company switcher list
    - **webhook routing:** Twilio To-number → company through `company_phone_numbers`; Stripe customer → company; texting-registration callbacks
    - **company slug lookup** for the hosted policy pages
    - **scheduler fan-out:** draft expiry, the Stripe meter batch, the daily Twilio poll, the scheduled-text dispatcher. Each lists the companies with due work, then **runs each company's work in its own `app_tenant` transaction**.
  - A lint rule (`eslint-plugin-boundaries`) allows importing `db/system` only from the auth routes, webhook entry points and scheduler modules.
- **RLS policy:** `company_id = nullif(current_setting('app.company_id', true), '')::uuid`. When the setting is missing or empty, this evaluates to NULL and **returns zero rows instead of erroring**.
- **Per request:** each request's transaction runs `SET LOCAL app.company_id = '<uuid>'`. `SET LOCAL` resets at commit, so pooled connections never carry a stale company.
- **Cross-tenant tests:**
  - For every resource route, a company-B user requesting a company-A ID gets **404**, not 403, so existence never leaks.
  - A raw SQL test as `app_tenant` shows **zero rows** with the setting absent, empty or set to another company, and shows that inserts or updates with a mismatched `company_id` are rejected (`WITH CHECK`).

### 3.2 Accounts, login, roles

- **Sign-in methods:** email + password (scrypt) and **Sign in with Google** (OIDC).
- **Email verification:**
  - Password sign-ups get a verification email.
  - Unverified users can use the app but **cannot** invite people, add a payment method, or submit texting registration.
  - Google sign-ins count as verified when Google says the email is verified.
- **Account linking:** a Google sign-in whose verified email matches an existing password user links to that user (`google_sub` is saved). An unverified Google email never links.
- **Password reset:** by emailed link, sent through Postmark.
- **Sessions:**
  - stored server-side (`sessions` table, hashed token)
  - httpOnly, Secure, SameSite=Lax cookie
  - **30-day sliding** expiry, so owners are not logged out constantly
  - revocable per device from the user menu
- **Multiple companies:** a user may belong to more than one company (for example, a consultant). The **active company** lives on the session, and a switcher appears only if there are two or more.
- **Invites:** the owner invites by email with a role. The link expires in 7 days. The invitee sets a password or uses Google.
- **Roles and permissions** (enforced in the API; the UI hides what you can't do):

| Capability | Owner | Office | Rep |
|---|---|---|---|
| Billing, plan, payment method | ✓ | — | — |
| Company settings, team, connections, agent rules | ✓ | — | — |
| Approve **spend** steps (ads, exact reports) | ✓ | only if the owner turns on `can_approve_spend` | — |
| Approve **message** steps (texts, proposals) | ✓ | ✓ | — |
| Approve **internal** steps (routes, demo, anything with no outside effect) | ✓ | ✓ | — |
| Jobs: view | all | all | jobs where `assigned_user_id` or `created_by_user_id` is them, plus unassigned `lead` jobs |
| Jobs: create and edit | ✓ | ✓ | the jobs they can view, plus new ones (`created_by_user_id` = them) |
| Customers and properties: view and edit | all | all | those linked to a job they can view, plus customers they created |
| CSV import + consent confirmation | ✓ | — | — |
| Company money totals: sum of `value_cents` across jobs (pipeline and won totals, dashboards) | ✓ | ✓ | — (reps see `value_cents` only on jobs they can view) |

- **Rate limits:**
  - login: 10 per 15 minutes per IP + email
  - API: 600 per minute per session
  - signature-verified webhooks are exempt

### 3.3 Core data (F1 tables)

All tables have `id uuid pk`, `created_at` and `updated_at`. Tenant tables also carry `company_id`.

- **`companies`**
  - Identity: `name`, `slug` (unique; used for the hosted policy pages), `legal_name`, `phone_e164`, `email`, `website`, `address` (street, city, state, zip)
  - `timezone`
  - `service_area geometry(MultiPolygon,4326)`, nullable; defaults to a 40-mile buffer around the address
  - `logo_url`
  - Billing state: `status (trial|trial_ended|active|past_due|canceled)`, `trial_ends_at`, `stripe_customer_id`, `plan_key`
- **`company_settings`**
  - `hourly_rate_cents` (default 2800; used later for hours saved)
  - `hail_threshold_in` (default 1.00)
  - `marketing_cap_per_7d` (default 2; may be lowered but never raised above 2)
  - `financing_apr_bps`, `financing_term_months` (used by the Estimator)
- **`users`:** `email` (unique, citext), `name`, `phone_e164`, `password_hash` (nullable), `google_sub` (nullable, unique).
- **`memberships`:** `company_id`, `user_id`, `role (owner|office|rep)`, `can_approve_spend bool`, `status (invited|active|disabled)`, `last_today_shown_on date` (nullable; used for the once-a-day Today window, §4.2); unique on `(company_id, user_id)`.
- **`invites`:** `company_id`, `email`, `role`, `token_hash`, `expires_at`, `accepted_at`.
- **`sessions`:** `token_hash`, `user_id`, `active_company_id`, `expires_at`, `last_seen_at`, `user_agent`, `ip`.
- **`customers`**
  - Name: `display_name`, `first_name`, `last_name`
  - `phones jsonb`, a list of `{e164, label, primary}`
  - `emails jsonb`
  - **Consent:** `sms_consent_status (none|express|attested|written|revoked)`, `sms_consent_source (import|web_form|call|text|manual)`, `sms_consent_at`, `sms_consent_by_user_id`, `sms_consent_evidence jsonb` (for example, the import ID plus the exact confirmation text)
  - `do_not_contact bool`
  - Origin: `source (import|manual|call|text|web|storm)`, `external_ref`, `tags text[]`, `created_by_user_id` (nullable for agent- or import-created records)
  - `archived_at` (nullable; archived records are hidden by default)
- **`properties`**
  - `customer_id` (nullable: a home in a storm path may have no customer yet)
  - Address: `address_line`, `city`, `state`, `zip`, `geom geometry(Point,4326)`, `timezone`
  - Geocoding: `geocode_source`, `geocode_accuracy`
  - Building: `footprint_id` (nullable; filled by Storm Scout and the Estimator), `year_built` (nullable)
  - `archived_at` (nullable)
  - Indexes: GIST on `geom`; a unique normalized address per company
- **`jobs`**
  - `customer_id`, `property_id`
  - `stage (lead|inspection|proposal|won|installed|lost)`, `stage_changed_at`
  - `source (storm|call|text|web|referral|import|manual)`
  - `value_cents` (nullable), `assigned_user_id` (nullable), `created_by_user_id` (nullable), `storm_id` (nullable)
  - `lost_reason` (nullable), `archived_at` (nullable)
- **`activities`** (timeline for any record)
  - `subject_type (customer|property|job)`, `subject_id`
  - `kind`, `summary` (plain English), `data jsonb`
  - `actor_type (user|agent|system)`, `actor_user_id`, `actor_agent`
  - `at`
- **`audit_log`:** `actor_user_id`, `action`, `target_type`, `target_id`, `before jsonb`, `after jsonb`, `ip`, `at`. Append-only; there is no update or delete grant.
- **`integrations`:** `provider`, `status (connected|error|revoked)`, `encrypted_credentials bytea`, `scopes text[]`, `connected_by_user_id`, `connected_at`, `last_error`. Credentials are encrypted with AES-256-GCM; the master key comes from the secret store.
- **`usage_events`:** `kind (ai_call_minute|sms_segment|mms|exact_report|texting_registration_fee|phone_number_month)`, `quantity numeric`, `unit_cost_cents`, `ref_type`, `ref_id`, `reported_to_stripe_at`, `at`.
- **Global tables** (§3.1; schema built in F1, mostly filled in F3):
  - **`company_phone_numbers`:** `company_id`, `e164` (unique), `capabilities text[]` (`sms`, `voice`), `provider_sid`, `purpose (main)`, `status`. Used to route inbound texts and calls to a company.
  - **`texting_registrations`:** one row per company: `subaccount_sid`, `brand_sid`, `brand_status`, `campaign_sid`, `campaign_status (none|pending|approved|rejected)`, `messaging_service_sid`, `submitted_at`, `approved_at`, `rejection_reason_plain`. A missing row means `none`.
  - **`webhook_events`:** `provider`, `event_id` (unique per provider), `received_at`. Repeated deliveries are ignored.

### 3.4 Approval queue — `agent_tasks` + `agent_task_steps`

This one model powers the "need your OK" pill, the review screen (R2), the activity feed and hours saved.

- **`agent_tasks`**
  - `agent (storm_scout|estimator|front_desk|claims|scheduler|follow_up|system)`
  - `kind` (for example `storm_plan`, `proposal_send`, `booking`)
  - `title`, plain English, such as "Storm plan for Westbury hail (up to 2.75")"
  - `summary`
  - `subject_type` / `subject_id` (optional link to a job, storm or customer)
  - `mode (needs_approval|live)`. `live` covers Front Desk's allowed live actions, which skip the queue but are still logged.
  - `status (draft|awaiting_owner|approved|declined|expired|running|done|partly_done|needs_attention)`
  - `expires_at` (for example, storm plans expire 48 hours after creation)
  - `approved_by_user_id`, `approved_at`, `declined_by_user_id`, `declined_at`, `decline_reason` (nullable)
  - `minutes_saved` (set when the task finishes)
  - `created_at`
- **`agent_task_steps`**
  - `task_id`, `position`
  - `type` (for example `send_sms_batch`, `send_proposal`, `create_ad_campaign`, `build_routes`, `order_exact_report`)
  - `approval_class (message|spend|internal)`, set by the step type's definition, not by the agent
  - `enabled bool` (default true)
  - `version int`, which goes up on every edit and is used for the optimistic check
  - `payload jsonb` (validated per `type` by a zod schema in `packages/shared`)
  - `preview jsonb`: what the review screen shows (message text, recipient count and sample, send time, ad creative and area, `max_spend_cents`)
  - `edited_by_user_id`, `edited_at`, `approved_by_user_id`, `approved_at`
  - `status (pending|awaiting_owner|skipped|queued|running|done|failed|needs_attention)`
  - `result jsonb` (counts: sent, delivered, blocked with reasons, and so on)
  - `idempotency_key` (unique)
  - `error_plain` (a reason a person can read)
- **Who may approve a step:**
  - `message` and `internal` steps: owner or office.
  - `spend` steps: owner, or an office user with `can_approve_spend`.
  - Reps approve nothing.
- **API:**
  - `GET /api/approvals` — tasks in `draft`, plus `awaiting_owner` for users who can approve spend, newest first, with step previews. The response also carries `count`, which feeds the pill.
  - `PATCH /api/approvals/:taskId/steps/:stepId` — `{enabled}` or `{payload}` edits, sent with the step `version`. The edit is re-validated, the preview is rebuilt, `version` goes up, and the change goes to `audit_log`.
  - `POST /api/approvals/:taskId/approve` — body `{steps: [{id, version}]}` listing every step the user saw.
    - **409** if any step's `version` changed since it was shown.
    - The server approves **every enabled step the caller may approve**; those are enqueued and move to `queued`.
    - Enabled `spend` steps the caller may not approve move to **`awaiting_owner`**. The task moves to `awaiting_owner` and shows in the owner's pill.
    - When the owner later approves, those steps are enqueued.
    - The task is `running` while any step is queued or running. **This is partial approval, never a 403**, so an office user is never blocked from sending the texts while the ad waits for the owner.
  - `POST /api/approvals/:taskId/decline` — body `{reason?}`; status becomes `declined`. Steps in `awaiting_owner` can also be declined one by one with `POST .../steps/:stepId/decline`.
  - `POST /api/approvals/:taskId/steps/:stepId/retry` — re-enqueues a `failed` or `needs_attention` step with the **same** idempotency key, so an outbound effect that already succeeded is never repeated.
  - `GET /api/tasks?agent=&status=&since=` — the activity feed.
- **Running:**
  - A pg-boss job runs one step. Job ID = `idempotency_key`, so a retry never repeats an outbound effect.
  - Handlers for each step type are registered by feature modules. Foundation ships a **`demo_noop`** handler and a **`send_sms_batch`** handler that goes through the send gate.
- **When a step is finished:** every outbound item it created (for example each recipient's message) is in a final state (`sent`, `delivered`, `failed`, `blocked`). A step with texts still `scheduled` for quiet hours stays `running` and shows "12 sending at 8:00 AM".
- **When a task finishes:**
  - Status becomes `done` if every enabled step is done, `partly_done` if some failed, and `needs_attention` if the failures need a person.
  - A task with steps still `awaiting_owner` is not finished.
  - `minutes_saved` = the sum of default minutes per step type from config (for example, `send_sms_batch` = 1.5 minutes per recipient, capped). The formula itself is finalized in the Agents-screen spec; Foundation stores the number.
- **Expiry:** a periodic job moves past-due drafts to `expired`. They show as "Expired — run again?" with a button that creates a fresh draft.

### 3.5 Send gate — `packages/send-gate`

- **Interface:** `decide(request) → {action: 'send'|'schedule'|'block', at?, reason?, rule?}`. It is a pure function over:
  - recipient: customer, phone, property time zone
  - company: settings, 10DLC status, opt-outs
  - message: purpose (`marketing|informational`), body, origin step
  - history: recent sends to this recipient
  - now
- **Rules, applied in order** (each tested on its own; F3 adds a `billing` rule that runs before rule 1, §5.2):
  1. **Registration:** the company's `texting_registrations.campaign_status` is not `approved` (a missing row counts as `none`) → **block**.
  2. **`do_not_contact`**, or the number appears in `opt_outs` for this company → **block**.
  3. **Consent:**
     - `marketing` needs status `attested` or `written`.
     - `informational` needs `express`, `attested` or `written`.
     - Otherwise **block**, with a reason such as "No texting consent on file".
  4. **Content:** a marketing body without the company name, or without opt-out wording ("Reply STOP to opt out"), is **blocked at draft time**. Templates add both automatically.
  5. **Dedupe:** the same `dedupe_key` (for example, `storm:{stormId}:{customerId}`) has already been sent → **block**.
  6. **Frequency** (marketing messages only):
     - Marketing sends to this recipient in the last 7 days ≥ `marketing_cap_per_7d` → **block**.
     - In FL, OK or MD, 3 or more **marketing** messages to the recipient in the last 24 hours → **schedule** for when the oldest drops out of the 24-hour window.
  7. **Quiet hours:**
     - Allowed window is 08:00–21:00 in the recipient's local time; FL, OK and MD use 08:00–20:00.
     - Applies to **all marketing** messages, and to informational messages **except** a reply within 15 minutes of the customer's own call or text. For example, a missed-call text-back or a booking confirmation sent during the call still goes out immediately.
     - Outside the window → **schedule** for the next opening.
     - Time zone comes from the property; the fallback is the company's time zone.
- **Scheduled messages are re-checked:**
  - A dispatcher job runs every minute. It picks `scheduled` messages that are due and **runs `decide()` again** before sending.
  - So a STOP, a do-not-contact change, a consent revocation or a billing pause that happened overnight is honored. The second decision is recorded on the message.
- **Inbound messages (`POST /hooks/twilio/sms`):**
  - The signature is verified.
  - The company is resolved from the To-number through `company_phone_numbers` (`app_system` lookup). The rest runs in that company's `app_tenant` transaction.
  - STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT and REVOKE (and plain-English variants such as "stop texting me", matched case-insensitively) add the number to `opt_outs` and set `sms_consent_status=revoked`. A single confirmation reply is sent.
  - **Manual changes:** setting a customer's consent to `revoked` or `do_not_contact` by hand also writes `opt_outs` rows for their phones, so every path that checks opt-outs agrees.
  - HELP replies with the company name and phone.
  - Every other message is stored as an inbound message. In Foundation that is a raw `messages` row; Front Desk adds the inbox later.
- **Tables:**
  - **`messages`:** `customer_id`, `channel (sms|mms|email)`, `direction (out|in)`, `purpose`, `body`, `status (scheduled|queued|sent|delivered|failed|blocked|received)`, `block_rule`, `block_reason`, `scheduled_for`, `sent_at`, `provider_message_sid`, `step_id`, `dedupe_key`, `segments int`.
  - **`opt_outs`:** `company_id`, `phone_e164`, `keyword`, `at`; unique on `(company_id, phone_e164)`.
- **Provider adapter:** Twilio Messaging Service per company, configured in F3. Tests use a fake adapter that records sends.

### 3.6 F1 API (besides approvals)

- **Auth:** `POST /api/auth/signup | login | logout | google | reset-request | reset`, `GET /api/auth/me`.
- **Company and team:** `GET/PATCH /api/company`, `GET/PATCH /api/company/settings`, `GET/POST /api/team/invites`, `PATCH /api/team/members/:id`.
- **Sessions:** `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id` (sign out a device).
- **Records:**
  - `GET/POST/PATCH /api/customers`, `/api/properties`, `/api/jobs` (list, filter, get, create, update)
  - `POST /api/{customers|properties|jobs}/:id/archive` and `/unarchive` (sets `archived_at`; there is no hard delete)
  - `GET /api/activities?subject=`
- **Health:** `GET /health` (public).
- **Validation and errors:** every request body is zod-validated. Errors come back as `{error: "<plain English>", field?}`. Stack traces never leave the server.

### 3.7 F1 acceptance criteria

- **Cross-tenant isolation:** two seeded companies. Automated tests show no cross-company reads or writes through any route. Raw SQL as `app_tenant` returns zero rows with the setting absent, empty or wrong, and rejects mismatched writes. Webhook routing and scheduler fan-out reach the right company and only that company.
- **Accounts and roles:**
  - The owner can sign up, sign in by password and by Google (with a stubbed OIDC provider in tests), invite an office user and a rep, and change roles.
  - The permission matrix in §3.2 has one test per row.
- **Approval queue (with `demo_noop` steps):**
  - draft → edit (turn a step off, edit a payload) → approve → steps run → `done`
  - optimistic-lock **409** when a step `version` changed
  - **partial approval:** a non-delegated office user approves a task with one message step and one spend step. The message step runs, the spend step and the task go to `awaiting_owner`, the owner sees it in their pill and approves, then the spend step runs
  - retry of a failed step does not repeat a completed effect
  - expiry
  - every edit and approval writes `audit_log`
- **Send gate:**
  - A unit test for every rule in §3.5, including FL/OK/MD, the 15-minute reply exception, and time-zone edge cases (DST change days).
  - An integration test showing `send_sms_batch` with mixed recipients producing the right send, schedule and block counts in `result`.
  - A test where a recipient texts STOP after their message was scheduled: the dispatcher's re-check blocks it.
- **Pricing:** `packages/shared` contains the ported pricing engine, and **every assertion** in v1 `tests/pricing.test.ts` is ported to Vitest with the same inputs and expected values, and all pass.
- **v1:** still runs from `v1/` (`npm ci && npm start`).

## 4. Milestone F2 — Shell and design kit (web)

### 4.1 Routing and windows

- **Router:** React Router (data routers).
- **The map is mounted once at the root and never unmounts.** Routes render **inside a single `<Window>`** centered over it.
- **Routes (in Foundation, feature routes render "coming soon" content):**

| URL | Window |
|---|---|
| `/` | none: map home |
| `/today` | Today window |
| `/approvals`, `/approvals/:taskId` | "Need your OK" list → R2 review |
| `/storm/*`, `/front-desk/*`, `/estimator/*`, `/jobs/*`, `/calendar/*`, `/agents/*` | feature windows |
| `/settings/*` | Company, Team, Connections, Billing, Setup |

- **Closing and navigating:**
  - **✕ and Esc** close the window and go to `/` (map home).
  - **Browser Back** goes to the previous history entry, which may be the previous window or `/`.
  - Opening a dock app replaces the current window and adds a history entry.
- **Window anatomy:**
  - title bar with app name and one-line description (as in the reel)
  - optional stat strip
  - body
  - **focus trap**, focus returned to the opener on close
  - `role="dialog"` with an `aria-labelledby` title
- **Size:** about 90% of the viewport, centered. Up to 1280×860 on large screens. The map stays visible around the edges.

### 4.2 Top bar, dock and Today

- **Top bar:**
  - logo and company name
  - **"N need your OK"** pill: count from `GET /api/approvals`; hidden at 0. With **exactly one** draft it opens `/approvals/:taskId` directly; with several it opens the `/approvals` list.
  - "N agents working": the number of tasks currently `running`, so 0 shows "All quiet"
  - weather for the company location (NWS, cached 30 minutes)
  - ⌘K search: Foundation searches customers, jobs and addresses; Core CRM extends it
  - user menu
- **Dock:**
  - Six apps with **labels always visible**.
  - Badges:
    - Storm: new storm plan
    - Front Desk: unread texts (later)
    - Estimator: proposals waiting
    - Jobs: none in Foundation
    - Calendar: none in Foundation
    - Agents: tasks needing attention
  - A "coming soon" state for apps not shipped yet: muted, with a tooltip.
- **Today window:**
  - Opens automatically **once per calendar day** (company time zone) on the first page load after login. The date is stored in `memberships.last_today_shown_on`.
  - Shows a greeting, the top 3 drafts (each opens R2), and today's appointments (empty until Core CRM).
  - Can be reopened from the user menu.
- **F2 API additions** (all tenant-scoped, role-filtered like §3.2):
  - `GET /api/search?q=` — customers, jobs and addresses, top 8 each
  - `GET /api/map/pins?bbox=&layers=` — customer and job points inside the view, clustered on the server above 2,000
  - `GET /api/weather` — NWS forecast for the company location, cached 30 minutes
  - `POST /api/me/today-shown` — records today's date in `memberships.last_today_shown_on`

### 4.3 Map home (MapLibre + MapTiler)

- **Layers:**
  - service area outline
  - **customer pins** (purple dots)
  - **open-job pins** colored by stage
  - a satellite toggle
  - a storm swath layer slot (filled by Storm Scout)
- **Interaction:** clicking a pin shows a small card (name, address, stage) with **Open**, which opens the job or customer window ("coming soon" until Core CRM).
- **Clustering** above 200 visible points.
- **Starting view:** fit to the service area.
- **Failure:** if tiles fail, a plain banner reads "The map is having trouble loading. Your work is safe." The app stays usable.
- **Map key:** the browser loads tiles with a **public, origin-restricted MapTiler key**. This is the one exception to "provider calls only on the server". The key can only fetch tiles from Roofline's domains. Geocoding and every other provider call stays on the server.

### 4.4 R2 review component (reused by every agent)

- **Lays out `agent_task_steps` in order.** Each row shows:
  - an **on/off switch**
  - a bold one-line step title
  - the preview (message bubble with a sample recipient's name filled in; recipient count with "see all"; send time with "quiet hours respected"; ad thumbnail and area; spend)
  - an action link: Edit, See map or Preview
- **Footer:**
  - an explanatory line, for example "Ad spend comes from your connected ad accounts"
  - **Not now** (declines, with an optional reason)
  - the primary button **"Approve N steps"**, which shows the max total spend when any spend step is on, for example "Approve 3 steps · up to $270"
- **States:**
  - disabled step: greyed
  - after Approve, the same window switches to **progress and results** with live counts
  - permission-limited:
    - For an office user without spend delegation, spend steps show "Your owner approves spending", and the button reads "Approve 2 steps · send ad to owner".
    - After approval, those steps show "Waiting for owner", matching the `awaiting_owner` state in §3.4.
- **Click limit:**
  - From the pill to "approved" is **2 clicks** when there is one draft: the pill opens the review directly (§4.2), then Approve.
  - With several drafts it is 3 (pill → pick task → Approve).
  - From the Storm window it is 2: "Approve storm plan", then "Approve 3 steps".
  - Playwright tests assert the one-draft and Storm cases.

### 4.5 Design kit (`packages/ui`)

- **Tokens (CSS variables):**

| Token | Value |
|---|---|
| `--bg` | `#efe9dc` |
| `--surface` | `#fffdf8` |
| `--surface-2` | `#f6f1e6` |
| `--text` | `#2b2620` |
| `--text-muted` | 60% of `--text` |
| `--accent` | `#f5b324` |
| `--accent-ink` | `#2b2620` |
| `--success` | `#2f9e44` |
| `--danger` | `#e03131` |
| `--line` | `#eee5cf` |
| `--radius-card` | 12px |
| `--radius-window` | 14px |
| `--shadow-window` | `0 12px 30px rgba(60,40,0,.15)` |
| `--font` | system UI stack |
| `--font-size-min` | 12px; body 14px; stat numbers 20–28px with tabular figures |
| Hail scale | `--hail-1` … `--hail-5`, yellow → magenta |

- **Components:** Button (primary, ghost, danger), IconButton, Card, StatCard, Toggle, Field (label, input, help, error), Select, Badge, Pill, Window, Dock, TopBar, Sheet (phone), Toast, EmptyState, ReviewSteps (§4.4), Avatar, Skeleton.
- **No raw `<button className=…>` in feature code.** Lint rule: feature folders import from `@roofline/ui`.
- **Accessibility:**
  - WCAG AA contrast on text
  - every interactive element reachable by keyboard
  - visible focus ring
  - touch targets ≥ 40px on phone

### 4.6 Phone layout (under 768px)

- **No floating windows:** routes render full-screen.
- **Bottom tab bar:** **My day** (`/today`) · **Map** (`/`) · **Jobs** · **Calendar** · **More** (Storm, Front Desk, Estimator, Agents, Settings).
- **No horizontal page scroll** at 375px. The R2 review stacks its steps and keeps the Approve button pinned to the bottom.

### 4.7 Copy rules (enforced)

- **Single string source:** all UI strings live in `apps/web/src/copy/*.ts`. Components read from there, with no inline literals in feature code.
- **Banned-word test** (whole-word, case-sensitive match on the strings in `copy/*.ts`):
  - **Technical words:** fails on `JSON`, `API`, `sandbox`, `env`, `webhook`, `null`, `undefined`.
  - **Enum tokens:** fails on any snake_case enum token from `packages/shared`, such as `needs_attention`, `awaiting_owner` or `partly_done`. Single plain words that happen to also be enum values ("Lead", "Won", "Owner", "Storm") are allowed.
  - **Vendor names:** `EagleView`, `Twilio`, `Google`, `Meta`, `Facebook`, `Stripe`, `Outlook`, `Microsoft` and `MapTiler` are allowed only in:
    - `copy/connections.ts` and `copy/setup.ts` (connecting accounts)
    - `copy/auth.ts` ("Sign in with Google")
    - `copy/billing.ts` (payment wording)
    - `copy/legal.ts`
- **Status labels** come from one map. For example: `draft` → "Waiting for your OK", `needs_attention` → "Needs attention", `partly_done` → "Mostly done — 3 couldn't send".

### 4.8 F2 acceptance criteria

- **Shell:**
  - The map home renders with seeded customer and job pins.
  - The dock shows six labeled apps.
  - The pill shows the live draft count.
  - Opening each app opens one centered window with its own URL.
  - Esc and ✕ go to `/`, Back goes to the previous entry, and deep-linking `/approvals/:id` opens the review directly.
  - The focus trap works.
- **Today window:** opens once per day per user, verified with a time-travel test.
- **R2 review:** with a seeded 3-step demo task (one spend step) as the only draft, the Playwright **click-count test passes (2 clicks)**. Turning a step off excludes it. An office user without delegation approves the other two, and the spend step shows "Waiting for owner". Results then appear live.
- **Phone:** at 375×812 the bottom tabs work, there is no horizontal scroll, and the Approve button stays pinned.
- **UI tests:**
  - no CSS `font-size` below 12px (stylelint rule)
  - banned-word test passes
  - axe accessibility scan has no serious or critical violations on the shell, the approvals window and the review screen

## 5. Milestone F3 — Sign-up, billing, setup checklist, import, texting registration

### 5.1 Self-serve sign-up (≤ 2 minutes to the map)

1. **Email + password, or Google.**
2. **Company name, business phone, business address.** The address is geocoded with Geocodio, and the time zone and a default service area are set from it.
3. **Map home with the Setup checklist window open.**

- **No credit card to start:** a **14-day trial** begins.
- **Card and plan required before anything that costs money:** texting registration submission, buying a phone number, ordering exact reports.
  - The checklist's `payment_method` step opens **Stripe Checkout in subscription mode**, where the owner picks a plan and enters a card.
  - The subscription starts with its trial ending on the company's `trial_ends_at`, so trial days aren't lost.
  - Usage during the trial is billed normally; the trial covers only the monthly fee.
- **Trial ends without a card:** `status=trial_ended`.
  - The app becomes **read-only**: data is viewable and exportable, nothing can be created or sent. The send gate blocks with rule `billing`.
  - A banner offers "Pick a plan to keep going". Data is kept for 90 days.

### 5.2 Billing (Stripe)

- **Plans:**
  - Configured in `packages/shared/billing.ts` as `{key, name, monthly_price_cents, included: {ai_call_minutes, sms_segments}, overage_cents: {ai_call_minute, sms_segment}}`, and synced to Stripe Products and Prices by a script.
  - **Prices are business configuration set by the owner before launch.** The code has no hard-coded prices.
- **Usage:**
  - **Fixed-unit usage** (`ai_call_minute`, `sms_segment`; MMS counts as 3 segments) is reported to **one Stripe Billing Meter per kind** within 5 minutes (batched job). Each plan's metered price uses Stripe graduated tiers, with the first tier free up to the included amount.
  - **Variable-price items are added as Stripe invoice items** on the next invoice, each with a plain description such as "Exact roof report — 812 Oak St".
    - **Exact reports:** Roofline's cost × (1 + markup % from config).
    - **Texting registration fees:** passed through at cost.
    - **Phone number monthly fees:** passed through at cost.
- **Webhooks (`POST /hooks/stripe`, signature verified):** subscription created, updated or deleted; invoice paid or payment failed.
- **Past due:**
  - A banner says "Your payment didn't go through. Texts and calls are paused until it's fixed," with a button to the Stripe customer portal.
  - Texting, outbound steps and exact-report orders are **paused**: the send gate blocks with rule `billing`, which is evaluated first, before rule 1.
  - Inbound calls: Front Desk keeps answering during a 7-day grace period, then calls go straight through to the company's backup phone. The Front Desk spec owns the details.
- **Billing page:** current plan, usage so far this period (by kind, with the included amount), invoices (Stripe portal link), and change plan.

### 5.3 Setup checklist

- **Table `setup_items`:** `company_id`, `key`, `status (todo|in_progress|waiting|done|skipped)`, `data jsonb`, `updated_at`.
- **Window `/settings/setup`:** a short list. Each row has a plain description, the agent it unlocks, a status chip, and one primary button.

| Key | What the owner does | Unlocks | Owned by |
|---|---|---|---|
| `company_basics` | Name, logo, service area (adjust on the map) | — | Foundation |
| `import_customers` | Upload CSV → map columns → preview → **confirm consent** → import | Storm texts to existing customers | Foundation |
| `texting_registration` | Business legal name, EIN, address, website (or use the Roofline-hosted page) → submit → **"Waiting on phone carriers (usually 10–15 days)"** | All texting | Foundation |
| `invite_team` | Invite office and reps | — | Foundation |
| `payment_method` | Add a card (Stripe) | Anything that costs money | Foundation |
| `prices_and_tiers` | Good/Better/Best templates and pricebook | Estimator | Estimator spec |
| `connect_calendar` | Google or Outlook | Front Desk booking, Scheduler | Core CRM spec |
| `phone_number` | Get a number + set up forwarding from the business line | Front Desk | Front Desk spec |
| `connect_ads` | Google Ads + Meta | Storm ads | Storm Scout spec |

- **Each agent card** (in the Agents window, later) shows what it is waiting on, for example "Front Desk turns on when: phone number ✓ · texting ⏳ · calendar ✗".
- **Not in the way:** the checklist never blocks using the app. It shows as a progress ring in the user menu until complete.

### 5.4 CSV customer import

- **Upload:** CSV or XLSX, up to 20,000 rows. Excel files are converted server-side.
- **Auto-mapping:** columns are matched by header synonyms (name/first/last, phone/mobile/cell, email, address/street, city, state, zip, notes, stage). The owner can fix a mapping with dropdowns.
- **Preview:**
  - the first 20 rows as they'll be saved
  - counts: new, matches an existing customer (by phone E.164 or email; updated, not duplicated), will be skipped (with reasons: no name, no phone and no email, bad phone)
- **Consent confirmation step (required before importing):**
  - **Unchecked** checkbox, with exact text stored in `sms_consent_evidence`: *"These customers agreed to receive text messages from [Company]. I understand [Company] is responsible for having their consent."*
  - Checked: **new** customers with phones get `sms_consent_status=attested`, `source=import`, `by=user`, `at=now`, and evidence `{import_id, text}`.
  - Unchecked: **new** customers get `express` (informational texts only). The UI explains plainly what that means.
  - **Existing (matched) customers, where consent can only stay the same or go up:**
    - **Never raised** from `revoked`, and never raised for a customer with `do_not_contact` or an `opt_outs` row.
    - **Never lowered:** `written` stays `written`, and `attested` stays `attested`, even when the box is unchecked.
    - Only `none` → `express`/`attested` and `express` → `attested` can happen.
    - `do_not_contact` is never cleared by an import.
  - The preview shows these counts ("12 customers previously opted out, and their texting stays off").
- **Processing:**
  - It runs as a background job and creates customers and properties (geocoded in batches with Geocodio).
  - **Jobs are created only when a stage column is mapped**, with that stage and `source=import`. Without one, no jobs are created, so a contact list doesn't become 20,000 fake leads.
  - A progress bar shows while it runs. At the end there is a summary and a **downloadable list of skipped rows with reasons**, a CSV produced by the server.
- **Table `imports`:** `file_name`, `mapping jsonb`, `counts jsonb`, `consent_attested bool`, `attested_by_user_id`, `attested_at`, `status`, `error_file_url`.
- **Audit:** the import and the consent confirmation are written to `audit_log`.

### 5.5 Texting registration (Twilio ISV, 10DLC)

- **At sign-up**, Roofline creates a **Twilio subaccount** for the company. Nothing costs money yet.
- **Checklist step `texting_registration`:**
  - Collects the brand info: legal name, EIN, business type, address, website, contact name, email and phone.
  - Defaults the campaign use case to "Customer care + marketing (mixed)", with sample messages prefilled from our templates.
  - Requires a payment method.
  - Submits the brand, then the campaign, through Twilio's ISV registration APIs.
  - Creates a Messaging Service with **one local number that can do both voice and SMS**, in the company's area code, recorded in `company_phone_numbers` with `purpose=main`. **Front Desk later reuses this same number** for calls, so the roofer has one Roofline number.
  - The number's monthly fee is a usage event.
- **Hosted policy pages:** many small roofers have no privacy policy page. Roofline hosts **`https://<company-slug>.<app-domain>/privacy` and `/terms`** per company, generated from lawyer-reviewed templates with the company's details, and uses those URLs in the registration. A roofer can provide their own URLs instead.
- **Status tracking:** Twilio status callbacks plus a daily poll update the `texting_registrations` table (schema in §3.3).
- **On rejection:** the checklist shows the plain reason and a **Fix and resubmit** button with the relevant fields highlighted.
- **Send gate:** rule 1 reads `campaign_status`.

### 5.6 F3 acceptance criteria

- **Sign-up:** a new user signs up and sees the map home with the Setup window in **under 2 minutes** (scripted Playwright run, three inputs). No card is needed.
- **Billing, in CI** (with the Stripe fake):
  - Trial → pick plan and card → `active`, with the trial end kept.
  - Trial end without a card → `trial_ended`, read-only, and the send gate blocks with rule `billing`.
  - A payment-failed webhook → past-due banner and rule `billing` blocks.
  - Usage rows → meter reports and invoice items with the right amounts.
- **Billing, in the manual smoke suite** (Stripe test mode): the same flow on a Stripe test clock, with meter events and invoice items visible in the Stripe dashboard.
- **Import:**
  - A 1,000-row fixture CSV with messy headers, duplicates and bad phones gives the right new, updated and skipped counts.
  - Attested customers have a full consent record; unchecked imports are `express` only.
  - Matched customers who were `revoked`, `written` or `do_not_contact` keep that status.
  - No jobs are created when no stage column is mapped.
  - The skipped-rows CSV is downloadable.
- **Texting registration:**
  - **In CI:** a recorded fake of Twilio's registration API moves the statuses correctly, rejection shows Fix and resubmit, and the number lands in `company_phone_numbers`.
  - **In manual smoke:** one real registration of Roofline's own test brand.
  - The hosted privacy and terms pages render with the company's details.
- **Checklist:** reflects every item's status, and items owned by later specs show "Coming with [feature]" until those ship.

## 6. Error handling (all milestones)

- **API errors:** plain-English `error` plus an optional `field`; the web app shows it next to the field or in a toast. No stack traces or codes in the UI.
- **Provider failures** (Twilio, Stripe, Geocodio, MapTiler, Postmark):
  - Retry with exponential backoff, up to 5 attempts, through pg-boss.
  - Then mark the step or item `needs_attention` with `error_plain`, for example "Couldn't reach the texting service. We'll keep trying; you can also retry now".
- **Optimistic concurrency** on approvals and edits: **409** produces "This changed while you were looking. Here's the latest," and the view reloads.
- **Webhooks are idempotent:** they store the provider event ID and ignore repeats.

## 7. Testing (tools)

- **Vitest** for unit and integration tests. **Testcontainers** (`postgis/postgis:16`) gives a real Postgres in integration tests.
- **Playwright** for end-to-end: desktop 1440×900 and phone 375×812, plus click-count helpers.
- **Fakes** for Twilio, Stripe, Geocodio, Postmark and the Google OIDC provider. **No live calls in CI.**
- **Manual smoke suite:** triggered by hand. It hits Stripe test mode (test clocks), Twilio (a real number and Roofline's own test brand, which has no true sandbox), Geocodio and Postmark. Acceptance items marked "manual smoke" run here.
- **v1 pricing tests** move from `node:test` to Vitest with every assertion kept as-is (§3.7).
- **Plan size:** F1 is the heaviest milestone, so its plan splits it into task groups: (a) repo, db and tenancy; (b) auth and sessions; (c) records API; (d) approval queue; (e) send gate.
- **CI** (GitHub Actions; the repo is private): lint, typecheck, unit, integration, end-to-end (headless).

## 8. Out of scope for Foundation (owned elsewhere)

- **Core CRM:** pipeline board, customer and job windows, calendar and sync, pricebook UI, PDF.
- **Estimator:** proposals, tiers, homeowner page, e-sign, EagleView.
- **Storm Scout:** hail worker, swaths, ads.
- **Front Desk:** voice handling on the main number bought in F3, forwarding setup, text inbox UI.
- **Agents spec:** Agents window content and the hours-saved formula.

## 9. Owner to-dos that unblock F3

These are lead-time items started now:

- **Accounts:** create the Twilio account and apply for ISV / A2P 10DLC access; create the Stripe account; create the MapTiler, Geocodio and Postmark accounts.
- **Domains:** pick and buy the app domain plus a short-link domain for texts.
- **Lawyer:** engage one to review the privacy and terms templates, the consent-confirmation wording, and the terms-of-service liability language.

# Roofline SaaS — Sub-project 2: Core CRM screens

- **Date:** 2026-10-12
- **Status:** written by Architect 2 under the owner's standing rule ("just build, take the recommended option"); every choice not already made in the master spec is recorded below as **Decision: … (recommended because …)**.
- **Parent:** [Master design](2026-10-10-roofline-saas-design.md) §8 row 2 and §14 ("pipeline stage rules and the calendar availability model"). Builds on [Foundation](2026-10-10-roofline-foundation-design.md) F1–F3 as built on `f2-shell` / `f3-setup`.
- **Delivery:** one milestone, **C1**, with one implementation plan (`docs/superpowers/plans/2026-10-12-roofline-core-crm.md`). The plan's lanes let the records screens and the calendar build in parallel.

---

## 1. Goal

Make Roofline usable as the roofer's **only CRM**. After Foundation, a company can sign up, import customers and approve agent drafts, but the Jobs and Calendar dock apps say "coming soon" and a pin or a search result opens a placeholder. Core CRM delivers:

- **The Jobs window:** a pipeline board (Lead → Inspection → Proposal → Won → Installed, plus Lost) with the stage rules the master spec left to this spec.
- **A customer window and a job window**, each with a **timeline** (every note, stage move, appointment, quote, text and agent action on that record).
- **Creating and editing** customers, homes and jobs from the screens (the F1 API exists; there was no UI).
- **The built-in calendar** (appointments: inspections, installs, adjuster visits) with **two-way Google and Outlook sync** per person, and the **availability model** the master spec assigned here (work hours, travel buffers, slots). Front Desk will book through the same availability service.
- **⌘K search** extended with actions ("New job", "Book an inspection") and recent records.
- **The pricebook** (ported from v1) and a **single-option job quote with a PDF** (ported from v1), so a roofer who used v1 loses nothing before the Estimator ships Good/Better/Best.
- **CSV export** of customers and jobs (F3's read-only mode promised "viewable and exportable").
- **Today window and setup checklist hooks:** today's appointments, and the `connect_calendar` checklist item becomes real.

**Not in Core CRM** (owned elsewhere):

- Good/Better/Best proposals, tier templates, the homeowner page, e-sign, instant measurements and exact reports (Estimator).
- Texting a homeowner about an appointment (confirmations, reminders): the **Scheduler agent** (next release). Core CRM sends nothing to customers.
- The text inbox and call log (Front Desk). Core CRM shows texts read-only on the timeline.
- Storm data on records beyond the existing `jobs.storm_id` (Storm Scout).
- Merging duplicate customers (see Decision 12).

## 2. What Foundation already gives us (the ground this spec stands on)

Read from the code on `f2-shell` and `f3-setup`, not from the earlier specs:

- **Tables** (`packages/db/src/schema/tenant.ts`): `customers` (phones jsonb `{e164,label?,primary?}[]`, emails jsonb, the consent record, `do_not_contact`, `source`, `tags`, `created_by_user_id`, `archived_at`), `properties` (address + `address_key` unique per company, `geom` point, `timezone`, geocode fields, `footprint_id`, `year_built`, `archived_at`), `jobs` (`stage` lead|inspection|proposal|won|installed|lost, `stage_changed_at`, `source`, `value_cents`, `assigned_user_id`, `created_by_user_id`, `storm_id`, `lost_reason`, `archived_at`), `activities` (`subject_type` customer|property|job|message, `kind`, `summary`, `data`, actor, `at`), `audit_log`, `integrations` (company-level encrypted credentials), `messages`, `company_settings`, `usage_events`.
- **Repos and scope** (`packages/db/src/repos/`): `customers.ts`, `properties.ts`, `jobs.ts` (create/update with "Moved to <Stage>" activities and audit), `activities.ts` (`addActivity`), `search.ts`, `map.ts`, `scope.ts` (`jobScope`, `customerScope`, `propertyScope`, `canSeeJobValue`), `paging.ts` (limit 1–200, default 50).
- **API** (`apps/api/src/routes/`): `GET/POST/PATCH /api/customers|properties|jobs`, `/:id/archive|unarchive`, `GET /api/activities?subjectType=&subjectId=`, `GET /api/search?q=`, `GET /api/map/pins|area`, `GET /api/weather`, approvals and tasks. Errors are `{error, field?}`. Capabilities in `permissions.ts`: `billing`, `company_admin`, `approve_*`, `import`, `view_money_totals`.
- **F3 additions:** provider seams with deterministic fakes and `FAKE_PROVIDERS=1` (`apps/api/src/providers/`), the `Geocoder` (Geocodio), pg-boss job queues (`jobs/queue.ts`, `JOB_NAMES`, `InlineJobs` in tests), the scheduler `SCHEDULES`, read-only mode for `trial_ended`/`canceled`, `@roofline/db/system` allowed in `account/**` and `public/**`.
- **Web** (`apps/web/src/`): the A2 shell (map, top bar, dock, one window per URL, phone tabs My day · Map · Jobs · Calendar · More), `AppWindow` + `WINDOW_COPY`, the R2 review, Today, Settings (Company, Team, Connections, Billing, Setup), the ⌘K `SearchDialog` (results link to `/customers/:id` and `/jobs/:id`), map pin cards that open `/customers/:id` and `/jobs/:id`, `copy/*.ts` as the only string source, feature hooks in `features/<feature>/api.ts`, the S1 kit plus F3's `Checkbox`, `ProgressBar`, `ProgressRing`, `FilePicker`, `Banner`.
- **Pricing:** `packages/shared/src/pricing.ts` is v1's engine (`pricebookSchema`, `defaultPricebook`, `scopeSchema`, `calculateQuote`, `money`) with every v1 assertion ported.
- **v1 PDF:** `v1/server/pdf.ts` (pdfkit, one quote, line table, totals, assumptions, page footer).

## 3. Pipeline (the Jobs window)

### 3.1 Board

- **Route:** `/jobs` (desktop and phone). The Jobs dock app and the phone "Jobs" tab open it.
- **Columns:** Lead · Inspection · Proposal · Won · Installed. **Lost** is a collapsed drawer at the end ("Lost (12)").
  - **Decision 1:** installed jobs leave the board 30 days after `stage_changed_at`; lost jobs show only in the drawer; both stay in the list view and in search (recommended because a board that only grows becomes unreadable within a season, and finished work is still one filter away).
- **Card:** customer name, address line, value (only for members who may see it: `canSeeJobValue`), assigned rep's avatar (or "Unassigned"), days in stage, and the next step with its date when set (§3.4). A card past the stuck limit shows "Stuck N days" (§3.3).
- **Column header:** stage label, count, and the column's value total for members with `view_money_totals` (owner, office). Reps see counts only.
- **Filters** (kept in the URL query so links and Back work): assignee (`me`, `unassigned`, a member, all), source, a text filter (name or address), and "Include archived".
- **List view:** `/jobs?view=list` — the same jobs as a sortable table (stage, customer, address, value, rep, updated). This is also the phone layout (Decision 7).
- **Paging:** each column shows its 50 most recently moved jobs, then "Show N more".
- **Moving a card:**
  - **Decision 7:** desktop uses native HTML drag-and-drop between columns, and **every card also has a "Move to…" menu**; phones use the menu only (recommended because it needs no third-party library, which the design-kit rules forbid for UI, and the menu is the keyboard-accessible and touch-friendly path that drag-and-drop can't be).
  - A move goes through the stage rules (§3.2); a move that needs input (a lost reason, a value for Won) opens a small sheet first.
  - Optimistic: the card moves at once and snaps back with the API's message on an error.

### 3.2 Stage rules (master §14)

- **Decision 2: the stages are free to move between, with four data rules** (recommended because small roofers skip steps constantly — a referral can go straight from Lead to Won — and hard sequencing would push them back to spreadsheets, while the four rules protect the numbers that matter):
  1. **Lost needs a reason.** Moving to `lost` requires `lost_reason`, chosen from a short list (Decision 6) or written in.
  2. **Won needs a value.** Moving to `won` requires `value_cents > 0` on the job (entered in the move sheet when missing). The Estimator later fills it from the signed option.
  3. **Installed only from Won.** Any other move to `installed` is refused: "Mark the job Won first."
  4. **Reopening a lost job** moves it to `lead` (or any open stage the user picks) and clears `lost_reason` (F1 already clears it).
- **Who may move:** whoever may edit the job (F1 §3.2): owner and office on all jobs, a rep on jobs they can see. No extra stage permission (recommended because reps sign contracts in the field; an owner who wants control sees every move on the timeline and in `audit_log`).
- **Every move** writes the F1 "Moved to <Stage>" activity, the audit row, and sets `stage_changed_at`.
- **Decision 3: one automatic move.** Booking an inspection appointment on a job in `lead` moves it to `inspection` ("Moved to Inspection — inspection booked") (recommended because it is the one transition that is unambiguous and frequent; the Estimator owns Proposal and Won automation when proposals are sent and signed).
- **Decision 6: lost reasons** are `price`, `another_roofer` ("Went with another roofer" — already the showcase seed's wording), `insurance_denied`, `no_damage`, `no_response`, `not_ready`, plus free text for "Other" (recommended because these are the reasons a roofer acts on later — re-contact after a storm, a price review — and a fixed list makes them countable). Stored as the plain label in `lost_reason`, so existing rows stay valid.

### 3.3 Stuck jobs

- **Decision 4:** a job in `lead`, `inspection` or `proposal` for more than **14 days** shows "Stuck N days" on its card and its window; the number is a company setting (`stuck_after_days`, 3–90) (recommended because two weeks without a move is the usual point where a roofing lead goes cold, and making it a setting costs one column).

### 3.4 Next step

- **Decision 5:** every job has an optional **next step**: a short text (≤ 120 characters) and an optional date (`next_step`, `next_step_on`) (recommended because it is the cheapest way to replace the sticky notes and reminder apps roofers use today, and it feeds the Today window without building a task system before the Follow-up agent).
- The Today window lists the user's jobs whose next-step date is today or past ("Follow up today").

## 4. Customer, home and job windows

### 4.1 Customer window — `/customers/:customerId`

- **Header:** display name, primary phone and email (click to copy; `tel:` and `mailto:` links on phone), tags, and a texting chip in plain words from one map: `none` "No texting consent", `express` "Texts about their own jobs only", `attested`/`written` "OK to text", `revoked` "Asked not to be texted"; plus "Do not contact" when set.
- **Sections:** Homes (each address with its jobs), Jobs (stage chips, value when allowed), Appointments (upcoming first), and the **Timeline** (§4.4).
- **Actions:** Edit (sheet: names, phones, emails, tags, consent, do-not-contact), New job, Add a home, Book an appointment, Archive/Restore.
- **Consent edits** follow F1: setting `revoked` or `do_not_contact` writes `opt_outs` rows for the phones; raising consent by hand is allowed only for owner and office and records `source manual`, the user and the time (F1 `assertMayChangeConsent`).
- **Customers list — `/customers`:** search box, filters (tag, texting consent, archived), sortable by name or last activity, paged 50. Reached from the Jobs window's "Customers" tab and from ⌘K.
  - **Decision 8:** customers live under their own `/customers` route but are entered from a "Customers" tab in the Jobs window rather than a seventh dock app (recommended because the master spec fixes the dock at six apps, and roofers think in jobs first).

### 4.2 Job window — `/jobs/:jobId`

- **Header:** customer name (links to the customer), address (links to the map at that pin), stage stepper (the five open stages; Lost shown as a state), value, assigned rep (a `Select` of active members plus "Unassigned"), source, days in stage, next step.
- **Sections:** Appointments (with "Book inspection" / "Book install"), Quotes (§7), Agent tasks about this job (from `agent_tasks.subject_*`, opening R2), and the Timeline.
- **Actions:** Move to…, Edit (value, source, rep, next step), Add note, Archive/Restore.

### 4.3 Creating records

- **`/customers/new`** and **`/jobs/new`** open a sheet-like form in the window:
  - **New job:** pick an existing customer (typeahead over `/api/customers?q=`) or create one inline (name, phone, email), then pick one of their homes or type a new address, then stage (default Lead), source (default Manual), rep (default: me for a rep, unassigned otherwise) and value.
  - **New customer:** names, phones, emails, an optional first home address, and consent (default `none`; a checkbox "They agreed to get texts about their jobs" sets `express` with source `manual`).
- **Decision 11: a typed address is geocoded on the server** with the F3 `Geocoder` when the home is created, filling `geom`, `timezone` and the normalized parts; when the geocoder can't find it or is down, the home is saved without a point and shows "Not on the map yet — Place on map" (recommended because the browser must never call the geocoder — master §9.3 — and a home without a pin is still a valid record).
- **Duplicates:** the F1 rules stand (a phone already on another active customer is a field error naming that customer, with a link; an address already saved is reused, not duplicated).
- **Decision 12: no customer merge in Core CRM** (recommended because import already matches by phone and email, F1 refuses duplicate phones, and a correct merge — moving jobs, homes, consent and timeline while keeping the strongest consent — is a sizable feature better done once real duplicate patterns are known; it is listed for the next CRM pass).

### 4.4 Timeline

- **One list, newest first,** on both windows:
  - the customer's, its homes' and its jobs' `activities` (stage moves, edits, notes, imports, consent changes, appointment and quote events, agent actions)
  - the customer's **texts** (`messages`, in and out, with status words from the F2 status map), read-only
- **Decision 9:** the timeline is assembled by one API read that merges activities and messages (recommended because the data already exists in two tables and a merged read is cheaper and safer than copying texts into activities).
- **Job window:** the same timeline filtered to that job, its home and texts sent for it.
- **Notes:**
  - **Decision 10:** a note is an `activities` row of kind `note` (≤ 2,000 characters) on a customer or a job; notes are append-only like the rest of the timeline (recommended because the timeline and audit model are already append-only, and an edit history for notes is not worth its complexity yet).
- **Paging:** 50 at a time, "Show older".

### 4.5 Export

- **Decision 13:** owner and office can download **customers.csv** and **jobs.csv** from the Customers tab and the Jobs list (recommended because F3's read-only mode promises export and a roofer leaving must be able to take their data). The CSV uses F3's formula-safe quoting (a cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`), includes archived records with an "Archived" column, and never includes consent evidence text. Export is allowed in read-only mode.

## 5. Calendar

### 5.1 Appointments

- **Table `appointments`** (tenant): `kind (inspection|install|adjuster|other)`, `title` (optional; defaults to the kind and the customer's name), `job_id`, `customer_id`, `property_id` (all optional, with composite company FKs), `assigned_user_id` (nullable), `starts_at`, `ends_at`, `all_day bool`, `status (scheduled|completed|canceled|no_show)`, `notes`, `source (manual|front_desk|scheduler|external)`, `created_by_user_id`, `canceled_at`, `archived_at`.
  - **Decision 14: default durations** — inspection 60 minutes, adjuster 60 minutes, other 30 minutes, install **all day** (one or more days) (recommended because these match how roofers book, and Front Desk needs a fixed inspection length to offer slots).
- **Rules:**
  - `ends_at > starts_at`; all-day appointments start and end at midnight in the company zone.
  - Linking: an appointment's `property_id` must belong to its `customer_id`, and its job's customer and home must match.
  - Conflicts with another appointment of the same person, or with a busy block (§5.4), are **warnings** ("Sam already has an inspection 2:00–3:00"), not refusals (recommended because owners double-book deliberately; Front Desk never sees a conflicting slot).
  - Booking an inspection on a `lead` job moves the job (Decision 3).
  - Every create, move, cancel and completion writes an activity on the job (or customer) and an audit row.
- **Who sees what:** owner and office see every appointment. **Decision 15:** a rep sees appointments assigned to them, plus appointments on jobs they can see (recommended because it mirrors F1's job visibility, so a rep never sees a stranger's address through the calendar).
- **Who edits:** owner and office edit all; a rep creates and edits the ones they can see.

### 5.2 Calendar window — `/calendar`

- **Views:** week (default on desktop), day, and an agenda list (default on phone). The URL carries the view and date: `/calendar?view=week&date=2026-10-12`.
- **People:** owner and office pick whose calendars to show (each member a color from the stage palette); reps see their own.
- **Times:** shown in the **company's time zone**, labeled when the browser's zone differs.
- **Creating:** click an empty slot (desktop) or "New appointment" (both) opens the appointment sheet with kind, customer/job typeahead, person, date/time (or all-day range), notes, and **suggested times** from §5.3 for the chosen person and kind.
- **Opening** an appointment shows its details, links to the job and customer, and Reschedule / Mark done / No-show / Cancel.
- **Decision 16: the calendar is built on the S1 kit with CSS grid, no calendar library** (recommended because calendar libraries ship their own components and styles, which the design-kit rules forbid, and the views needed — week, day, agenda — are small).
- **Today window:** "Today's appointments" lists the signed-in person's appointments today (owner and office get a "See everyone's day" link to the calendar day view). "Follow up today" lists next steps due (§3.4).

### 5.3 Availability model (master §14)

- **Decision 17: weekly work hours per person, a fixed travel buffer, a minimum notice** (recommended because it is the simplest model that Front Desk can book against safely, needs no routing vendor, and each part is a single setting):
  - **Company default work hours:** Monday–Friday 08:00–18:00 and Saturday 08:00–12:00 in the company zone; editable by the owner. Each member may override with their own weekly hours (owner edits anyone's; members edit their own).
  - **Travel buffer:** 30 minutes (company setting, 0–120) kept free before and after each appointment that has a home, unless the neighboring appointment is at the same home.
  - **Minimum notice:** 2 hours (company setting, 0–72 hours); no slot starts sooner.
  - **Slot grid:** slots start on the hour or half hour.
  - **Busy time** = the person's appointments (not canceled) + their calendar busy blocks (§5.4) + the travel buffers.
- **Shared pure function:** `findSlots({ workHours, busy, durationMinutes, bufferMinutes, from, to, timeZone, stepMinutes: 30, minNoticeMinutes, now })` → slots, used by the appointment sheet now and by Front Desk later.
- **API:** `GET /api/calendar/availability?userId=&kind=&from=&to=` → `{ slots: [{start, end}] }` (at most 14 days). With no `userId`, the union across members who do that kind of visit (owner and reps for inspections; anyone for other kinds) with the person for each slot (`userIds`).
- **Decision 18: no drive-time routing** (recommended because a fixed buffer is predictable and free; Storm Scout's route algorithm is the place for real distances).

### 5.4 Google and Outlook two-way sync

- **Who connects:** **Decision 19: each person connects their own calendar** (Google or Outlook) from Settings → Connections → "Your calendar" (recommended because reps and owners keep separate calendars and a company-wide calendar account is rare in 2–20 person roofers). One connection per person; the person picks which of their calendars Roofline writes to (their primary by default).
- **Table `calendar_connections`** (tenant): `user_id`, `provider (google|microsoft)`, `account_email`, `calendar_id`, `calendar_name`, `encrypted_credentials bytea` (refresh token, AES-256-GCM with `ENCRYPTION_KEY`), `scopes text[]`, `status (connected|error|revoked)`, `last_error_plain`, `sync_cursor` (Google `syncToken` / Graph `deltaLink`), `last_synced_at`; unique `(company_id, user_id)`.
- **OAuth:**
  - Google: scopes `openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly`, offline access with `prompt=consent`.
  - Microsoft: scopes `offline_access User.Read Calendars.ReadWrite`, the common (multi-tenant) endpoint.
  - The flow starts at `GET /api/calendar/connect/:provider` (redirects with a signed, single-use `state` naming the user and company, 10 minutes) and returns to `GET /api/calendar/oauth/:provider/callback`. Errors return to `/settings/connections` with a plain message.
  - New config: `GOOGLE_CLIENT_SECRET` (with the existing `GOOGLE_CLIENT_ID`), `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`. Unset → the connect buttons say "Calendar connections aren't set up yet."
- **Out (Roofline → calendar):** creating, moving or canceling an appointment assigned to a connected person queues a `calendar-push` job that creates, updates or deletes **one event** on their chosen calendar: title "Inspection — Maria Lopez", the home's address as the location, the job link in the description, no customer phone or email (recommended because calendars are often shared with family; the link is enough). The event id and etag are kept in **`calendar_event_links`** (`appointment_id`, `connection_id`, `provider_event_id`, `etag`, `last_pushed_at`). Reassigning moves the event from one person's calendar to the other's.
- **In (calendar → Roofline):**
  - **Decision 20: polling, not push notifications** — a `calendar-pull` schedule every 5 minutes runs an incremental sync per connection (Google `events.list` with `syncToken`; Graph `calendarView/delta`), and opening the Calendar window triggers one for the viewer (recommended because Google push channels need a verified domain and renewals every few days, Graph subscriptions expire within days, and five minutes is fresh enough for roofing schedules; push can be added later without changing the model).
  - **Linked events** (ones Roofline created): a time change moves the appointment ("Moved in Google Calendar"); a deletion **cancels** the appointment ("Canceled in Outlook"). Title and description edits are ignored.
  - **Other events** become **busy blocks** — **Decision 21:** only start, end and all-day are stored (table `calendar_busy_blocks`: `connection_id`, `user_id`, `provider_event_id`, `starts_at`, `ends_at`, `all_day`), never titles, attendees or locations, and only for the next 60 days (recommended because availability needs only the times, and storing other people's private event details would be needless risk). They show on the calendar as grey "Busy" blocks. Events marked free/transparent are skipped.
  - **Conflicts:** **Decision 22:** the most recent change wins, by the event's `updated` time against the appointment's `updated_at`; Roofline writes with the stored etag (`If-Match`), and a 412 re-reads before deciding (recommended because both sides are edited by the same small team and last-writer-wins is what they expect from every calendar app).
- **Failures:** a refresh token that stops working sets the connection to `error` with "Reconnect your calendar"; pushes retry with backoff (pg-boss, 5 attempts) and then show "Couldn't update your calendar" on the appointment with a retry button. Nothing blocks using the built-in calendar.
- **Disconnect:** deletes the stored token and busy blocks, keeps the appointments and leaves the already-written events in place (the user is told).
- **Setup checklist:** `connect_calendar` becomes **done when at least one active member has a connected calendar** (company-level), and "Coming with the calendar" goes away.

## 6. ⌘K search, extended

- **Results:** customers, jobs and addresses (F2) now open their real windows.
- **Decision 23: actions and recents, no new indexes** — the dialog adds an **Actions** group ("New job", "New customer", "Book an inspection", "Open calendar", "Export customers" for owner/office), matched by words in the query, and shows the person's **last 8 opened records** when the query is empty (kept in the browser's local storage) (recommended because the F2 search is already fast and role-scoped; actions and recents are what make ⌘K the "3 clicks or fewer" shortcut the master spec asks for).
- **Appointments** are not searched (the calendar is the place for them).

## 7. Pricebook and job quotes (ported from v1)

### 7.1 Pricebook

- **Table `pricebooks`** (tenant, one row per company): `prices jsonb` (v1's `pricebookSchema`), `defaults jsonb` (`wastePercent`, `markupPercent`, `taxPercent`, `material`), `updated_by_user_id`.
- **Settings → Prices** (`/settings/prices`): the v1 price list grouped (Materials, Labor, Per-foot items, Per-job items) with dollar inputs; owner edits, office reads, reps don't see it. Saved values are validated by `pricebookSchema`.
- A company without a row uses `defaultPricebook`, labeled "Example prices — set your own".
- **Decision 24:** Core CRM keeps v1's pricebook shape unchanged (recommended because the ported engine and its tests depend on it; the Estimator adds tier templates on top rather than reshaping it).

### 7.2 Job quotes

- **Decision 25: a single-option quote per job, as v1 had** (recommended because it keeps v1 users whole before the Estimator ships, it exercises the pricebook and PDF end to end, and the Estimator's Good/Better/Best can start from these quotes rather than replace them):
  - **Table `quotes`** (tenant): `job_id`, `number` (`Q-0001` per company, from a per-company counter `quote_counters`), `status (draft|final)`, `measurement jsonb` (`source: 'manual'`, area, area type, pitch, notes), `scope jsonb` (v1 `scopeSchema`), `prices jsonb` (the pricebook snapshot), `calculation jsonb` (the frozen `calculateQuote` result), `notes`, `valid_until date` (default 30 days), `created_by_user_id`, `finalized_at`.
  - **Editor** (in the job window): roof area and whether it is surface or footprint, pitch, material, waste, stories, layers, ridge/edge/valley feet, decking sheets, markup and tax; the price updates live (the same `calculateQuote` runs in the browser) and is recomputed on the server on save.
  - **Final:** "Mark final" freezes the quote (no more edits; "Copy to a new quote" makes a draft). A final quote sets the job's `value_cents` when the job has none.
  - **Labels:** every quote says "Estimate" (master §9.2). There is no sending to the homeowner in Core CRM (the Estimator's homeowner page does that).

### 7.3 PDF

- **`GET /api/quotes/:id/pdf`** streams a PDF built on the server with `pdfkit` (ported from v1's `renderPdf`): company name and contact line, "Roofing estimate", quote number, dates, customer and address, scope line, the line table, direct cost, overhead & profit, tax, total, "Scope & assumptions" (v1 text), notes, and a page footer "Q-0001 · Prepared with Roofline · 1 / 2". S1 colors replace v1's green. A draft carries "Draft — not final".
- **Decision 26: rendered on request, not stored** (recommended because object storage arrives with the Estimator's signed proposals, and a quote PDF is cheap to rebuild from its frozen snapshot).

## 8. Shell changes

- **Dock:** Jobs and Calendar are no longer "coming soon". **Decision 27: no new dock badges** (recommended because a badge means "something needs you", and nothing in Core CRM needs the person in a way the Today window doesn't already show).
- **Map:** pin cards' **Open** goes to the real windows; the job window's address opens `/?focus=<propertyId>`, which centers the map on that pin and opens its card.
- **Phone:** the Jobs tab opens the list view; the Calendar tab opens the agenda; every Core CRM window works at 375×812 with no horizontal scroll.
- **Settings:** new tabs **Prices** (owner/office) and **Schedule** (company work hours, travel buffer, minimum notice, stuck days — owner; each person's own hours — everyone); **Connections** gains "Your calendar" (everyone) above the company ad-account section (still "Coming with Storm Scout").

## 9. API (all tenant-scoped, role-filtered as F1 §3.2, errors `{error, field?}`)

- **Jobs:**
  - `GET /api/jobs/board?assigned=&userId=&source=&q=&archived=` → `{ columns: [{stage, count, totalCents|null, jobs: JobCard[]}], lost: {count} }` (50 per column; `stage=&offset=` pages one column).
  - `PATCH /api/jobs/:id` (F1) gains the stage rules (§3.2), `nextStep`, `nextStepOn`.
  - `GET /api/jobs/:id/view` → the job, customer, home, appointments, quotes, agent tasks, can-flags.
- **Customers:** `GET /api/customers/:id/view` → the customer, homes with jobs, upcoming appointments, can-flags; `GET /api/timeline?customerId=|jobId=&before=` → merged activities and texts.
- **Notes:** `POST /api/notes {subjectType: 'customer'|'job', subjectId, body}`.
- **Homes:** `POST /api/properties` (F1) geocodes server-side when no point is given (Decision 11); `POST /api/properties/:id/locate`.
- **Appointments:** `GET /api/appointments?from=&to=&userIds=`, `POST /api/appointments`, `GET/PATCH /api/appointments/:id`, `POST /api/appointments/:id/cancel|complete|no-show`; responses carry `warnings: string[]`.
- **Availability:** `GET /api/calendar/availability` (§5.3).
- **Schedule settings:** `GET/PUT /api/calendar/settings` (company: work hours, buffer, notice, stuck days — owner), `GET/PUT /api/calendar/my-hours` (anyone, own), `PUT /api/calendar/hours/:userId` (owner).
- **Calendar connections:** `GET /api/calendar/connection`, `GET /api/calendar/connect/:provider`, `GET /api/calendar/oauth/:provider/callback`, `PATCH /api/calendar/connection {calendarId}`, `GET /api/calendar/connection/calendars`, `DELETE /api/calendar/connection`, `POST /api/calendar/sync`.
- **Pricebook and quotes:** `GET/PUT /api/pricebook`; `GET /api/jobs/:id/quotes`, `POST /api/jobs/:id/quotes`, `GET/PATCH /api/quotes/:id`, `POST /api/quotes/:id/finalize`, `POST /api/quotes/:id/copy`, `GET /api/quotes/:id/pdf`.
- **Export:** `GET /api/export/customers.csv`, `GET /api/export/jobs.csv` (owner, office).
- **Today:** `GET /api/today` → `{ appointments, followUps }` for the signed-in person.

## 10. Data changes (one migration pair, as F3 did)

- **New tenant tables:** `appointments`, `calendar_connections`, `calendar_event_links`, `calendar_busy_blocks`, `member_schedules` (`user_id`, `weekly_hours jsonb`), `pricebooks`, `quotes`, `quote_counters` (`company_id` pk, `next_number`). Each has `company_id`, RLS forced with the standard `tenant_isolation` policy, composite company FKs, and grants for `app_tenant` (SELECT/INSERT/UPDATE; DELETE only on `calendar_busy_blocks` and `calendar_event_links`).
- **`app_system`:** column-level SELECT on `calendar_connections (id, company_id, user_id, status, last_synced_at)` plus an `app_system_all` policy, for the pull scheduler's fan-out.
- **`jobs` gains** `next_step text`, `next_step_on date`; an index `(company_id, stage, stage_changed_at)`.
- **`company_settings` gains** `work_hours jsonb not null default <Decision 17>`, `travel_buffer_minutes int not null default 30` (0–120), `min_notice_minutes int not null default 120` (0–4320), `stuck_after_days int not null default 14` (3–90); tenant UPDATE grants on these columns.
- **`activities.subject_type`** keeps its values; appointment and quote events are filed on the job (or the customer when there is no job).

## 11. Copy and plain words

- New copy files: `copy/jobs.ts`, `copy/customers.ts`, `copy/calendar.ts`, `copy/prices.ts`, `copy/quotes.ts`. Vendor names ("Google Calendar", "Outlook") appear only in `copy/connections.ts`, which the calendar screens import for those strings (F2 rule).
- Stage, appointment-kind, appointment-status and lost-reason labels each come from one map; snake_case values (`no_show`, `another_roofer`, `insurance_denied`) never appear in copy text.
- Money shows whole dollars on cards and two decimals on quotes; times show like "Tue, Oct 13 · 2:00 PM".

## 12. Error handling

- As Foundation §6. Additions:
  - Calendar provider failures never block a Roofline action: the appointment saves, the push retries, and the appointment shows "Couldn't update your calendar" after the last attempt.
  - Geocoder failures never block saving a home (Decision 11).
  - Stage-rule refusals are 400 with the field (`lostReason`, `valueCents`, `stage`) and a plain message.

## 13. Testing

- **Unit:** stage rules; `findSlots` (work hours, buffers at different and same homes, minimum notice, DST change days, all-day busy blocks, the union across people); lost-reason labels; quote numbering; CSV escaping; timeline merge ordering.
- **Integration (Testcontainers):** board grouping, totals hidden from reps, paging; stage rules including the inspection auto-move; appointment visibility for reps; availability against seeded appointments and busy blocks; calendar connect (fake OAuth), push (create, move, reassign, cancel, retry), pull (move, delete → cancel, busy blocks, sync-token reset after Google's 410), conflict last-writer-wins; pricebook validation; quote freeze; PDF bytes start with `%PDF` and contain the quote number; export CSV; cross-tenant 404s on every new route.
- **Recorded fakes:** Google Calendar and Microsoft Graph adapters tested against recorded JSON through an injected `fetch` (as F3 did for Twilio and Stripe); `FAKE_PROVIDERS=1` swaps in a fake calendar provider for development and end-to-end runs.
- **Browser end-to-end (Playwright):** desktop and phone; click counts: **a new job from the map home in 3 clicks or fewer** to its form, **an inspection booked from a job in 3 clicks or fewer** (Book inspection → pick a suggested time → Save), and moving a card to Won.
- **Accessibility:** axe on the board, the job window, the customer window and the calendar week view: no serious or critical violations; the "Move to…" menu and the calendar grid are fully keyboard-operable.
- **Manual smoke:** connect a real Google and a real Outlook calendar, create/move/cancel in both directions.

## 14. Acceptance criteria (C1)

- **Pipeline:** the board shows the seeded showcase jobs in the right columns with counts (totals for owner and office only); a card moves by drag and by "Move to…"; Lost asks for a reason; Won asks for a value; Installed only from Won; a stuck job shows its days; a rep sees only their jobs and unassigned leads.
- **Records:** a customer and a job can be created, edited, archived and restored from the screens; a new home is geocoded (fake) and appears on the map; a duplicate phone is a field error with a link; the timeline shows notes, stage moves, appointments, quotes and texts in order.
- **Calendar:** appointments are created, moved, completed and canceled in week, day and agenda views; booking an inspection on a lead moves the job; suggested times respect work hours, buffers and minimum notice; reps see only their own and their jobs' appointments.
- **Sync (CI, with recorded fakes):** a Roofline appointment appears in the person's Google and Outlook calendar and moves and disappears with it; an external move or delete is applied within one pull; outside events become busy blocks with no titles stored; a broken token shows "Reconnect your calendar"; the `connect_calendar` checklist item turns done.
- **Search:** ⌘K finds customers, jobs and addresses and offers the actions; recents show on an empty query.
- **Pricebook, quotes and PDF:** the owner edits prices; a quote prices identically to the ported engine; Mark final freezes it; the PDF downloads with the quote's numbers.
- **Export:** customers.csv and jobs.csv download with formula-safe cells, also in read-only mode.
- **Today:** shows today's appointments and due follow-ups.
- **Phone:** the Jobs list, the job and customer windows and the agenda work at 375×812 with no horizontal scroll.
- **UI rules:** copy-rules, 12px and axe tests pass; no vendor name outside `copy/connections.ts`.

## 15. Owner to-dos (lead time)

- **Google Cloud:** an OAuth client (web) for Calendar with the two calendar scopes, and the **OAuth consent screen verification** (master §10 — can take weeks; unverified apps are capped at 100 users). Until verified, pilot roofers are added as test users.
- **Microsoft Entra:** a multi-tenant app registration with `Calendars.ReadWrite`, `User.Read`, `offline_access`, and **publisher verification**.
- Set `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` on Render.

## 16. Decisions index

1 board cutoff · 2 free stages with four rules · 3 inspection auto-move · 4 stuck after 14 days · 5 next step · 6 lost reasons · 7 drag + Move menu · 8 customers under Jobs · 9 merged timeline · 10 notes as activities · 11 server geocoding · 12 no merge yet · 13 CSV export · 14 default durations · 15 rep calendar visibility · 16 no calendar library · 17 availability model · 18 no routing · 19 per-person calendar · 20 polling sync · 21 busy blocks without titles · 22 last writer wins · 23 search actions and recents · 24 v1 pricebook shape · 25 single-option quotes · 26 PDF on request · 27 no new badges.

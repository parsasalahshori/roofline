# C1 acceptance checklist (spec section 14)

Status: the API, shared-package and web component tests below run in CI (`.github/workflows/ci.yml`, the Platform job); the API tests are database-backed and, with no Docker on the build machine, were not run locally. The Playwright specs were only listed locally with `npx playwright test --list -c apps/web/playwright.config.ts` and are proven on CI through the E2E job (`--project desktop --project phone`). The new `phone.spec.ts` and `a11y.spec.ts` tests are cited by the names they have today; a later lead pass may adjust those names, so check the files if one does not match. Nothing live is covered by CI: connecting a real Google or Outlook calendar is a manual step (see Gaps).

Paths are under `apps/api/test/` (API), `apps/web/e2e/` (Playwright), `apps/web/test/` (web components), `packages/<name>/test/` and `docs/superpowers/`. Test names are quoted exactly as written in the files.

## Pipeline
- **The board shows the seeded showcase jobs in the right columns with counts (totals for owner and office only)**
  - `apps/web/e2e/crm.spec.ts`: "the board shows the showcase pipeline".
  - `apps/api/test/jobs-board.test.ts`: "the showcase jobs land in their columns with counts"; "totals for owner and office, none for reps".
  - `apps/api/test/showcase.test.ts`: "has exactly the stage counts the demo needs".
  - `apps/web/test/jobs-board.test.tsx`: "columns and counts from a stubbed BoardView"; "totals shown for owner, hidden when null".
- **A card moves by drag and by "Move to..."**
  - `apps/web/e2e/crm.spec.ts`: "drag a lead to Inspection, then Lost asks why".
  - `apps/web/test/jobs-board.test.tsx`: "drag a card from Lead to Inspection moves it before the response"; "a 400 rolls back and toasts"; "a card from Show N more can be dragged to another stage"; "Move to Lost opens the sheet and sends stage lost with reason Price".
  - `apps/web/test/job-window.test.tsx`: "stepper click to Proposal sends PATCH".
  - `apps/api/test/jobs-stage-rules.test.ts`: "the activity and audit rows for a move".
- **Lost asks for a reason**
  - `apps/web/e2e/crm.spec.ts`: "drag a lead to Inspection, then Lost asks why".
  - `apps/web/test/jobs-board.test.tsx`: "Move to Lost opens the sheet and sends stage lost with reason Price".
  - `apps/web/test/job-window.test.tsx`: "Lost via stepper opens the sheet".
  - `apps/api/test/jobs-stage-rules.test.ts`: "%s is refused with its message and field" (case "lead to lost without a reason"); "reopening a lost job clears the reason".
  - `apps/api/test/jobs.test.ts`: "a job cannot start lost without a reason".
  - `packages/shared/test/pipeline.test.ts`: "%s to lost with no reason is refused"; "%s to lost with a reason is allowed".
- **Won asks for a value**
  - `apps/web/test/jobs-board.test.tsx`: "Won without a value asks for it"; "Won takes a value with thousands commas"; "Won refuses a value with letters in it"; "Won refuses commas that are not thousands groups".
  - `apps/api/test/jobs-stage-rules.test.ts`: "%s is refused with its message and field" (cases "lead to won without a value" and "lead to won with a value of 0"); "lead to won with a value succeeds, and won can then be installed".
  - `packages/shared/test/pipeline.test.ts`: "%s to won without a value is refused"; "lost to won without a value is refused".
- **Installed only from Won**
  - `apps/web/test/jobs-board.test.tsx`: "Installed is not offered unless the job is Won".
  - `apps/api/test/jobs-stage-rules.test.ts`: "%s is refused with its message and field" (case "lead to installed"); "a new job may start Installed (a past job); Lost still needs a reason" (Ruling CE: a new job may start Installed).
  - `packages/shared/test/pipeline.test.ts`: "%s to installed is refused"; "won to installed is allowed, even without a value".
- **A stuck job shows its days**
  - `apps/api/test/jobs-board.test.ts`: "stuck cards".
  - `packages/shared/test/pipeline.test.ts`: "%s is stuck only after the threshold"; "%s is never stuck"; "respects a smaller threshold"; "two minutes across local midnight is 1 day"; "25 hours across the fall-back change is 1 day"; "across spring-forward is 1 day".
- **A rep sees only their jobs and unassigned leads**
  - `apps/web/e2e/crm.spec.ts`: "a rep sees only their jobs".
  - `apps/api/test/jobs-board.test.ts`: "a rep sees their jobs and unassigned leads only".
  - `apps/api/test/rep-visibility.test.ts`: "a rep sees jobs assigned to them, jobs they created, and unassigned leads — and no others"; "a rep does not see another rep's job: GET → 404"; "a rep does not see an unassigned job that has moved on from lead"; "a rep can't PATCH another rep's job: 404, and nothing changes".

## Records
- **A customer can be created, edited, archived and restored from the screens**
  - `apps/web/test/create-customer.test.tsx`: "new customer posts the customer then the property and navigates".
  - `apps/web/test/customer-edit.test.tsx`: "tags are split on commas, trimmed and de-duplicated"; "adding a phone and marking it primary sends exactly one primary number".
  - `apps/web/test/customer-window.test.tsx`: "Archive asks first: Keep customer sends nothing, Yes archive posts the archive call"; "an archived customer shows Restore, and Restore posts the unarchive call".
  - `apps/api/test/customers.test.ts`: "stores the number as E.164, makes it primary, and answers with the documented shape"; "PATCH changes only the fields sent and answers with the customer"; "archived customers are hidden from the list unless includeArchived=true"; "unarchive brings it back; archiving twice changes nothing and logs nothing new".
- **A job can be created, edited, archived and restored from the screens**
  - `apps/web/e2e/crm.spec.ts`: "a new job from the map home in 2 clicks to its form" (also creates the job with a new customer and address).
  - `apps/web/test/create-job.test.tsx`: "new job with an existing customer and home posts once and navigates"; "inline new customer path creates customer, property, then job"; "the stage select offers only Lead, Inspection and Proposal"; "all seven sources are offered as words".
  - `apps/web/test/job-window.test.tsx`: "edit sheet sends only the changed value in cents"; "edit sheet rejects a bad amount"; "archive asks first, then posts".
  - `apps/api/test/jobs.test.ts`: "a new job is a manual lead with nobody assigned, and the answer has the documented shape"; "every field can be given at once".
  - `apps/api/test/rep-visibility.test.ts`: "an archived job is visible to a rep exactly when an active one would be".
- **A new home is geocoded (fake) and appears on the map**
  - `apps/web/e2e/crm.spec.ts`: "a new job from the map home in 2 clicks to its form" (the pin appears on the map).
  - `apps/api/test/property-geocode.test.ts`: "a new home at 1200 Farnam St gets a point and the Chicago zone"; "1 Nowhere Rd is saved without a point"; "a failing lookup still saves the address"; "locate 200: a home saved without a point gets one, and GET shows it".
  - `apps/api/test/map.test.ts`: "returns customer and open-job pins inside the box".
  - `apps/web/test/create-customer.test.tsx`: "a home that was not found shows the not-on-map toast".
- **A duplicate phone is a field error with a link**
  - `apps/web/test/customer-edit.test.tsx`: "a duplicate phone shows the message under the number with a link to search that number".
  - `apps/api/test/customers.test.ts`: "a second customer written 402.555.0144 is refused: 409 on that phone"; "the 409 names the phone that clashed, by its place in the request".
- **The timeline shows notes, stage moves, appointments, quotes and texts in order**
  - `apps/web/e2e/crm.spec.ts`: "the timeline shows a note, a stage move and a quote".
  - `apps/api/test/timeline.test.ts`: "a stage move, a note and an inbound text appear newest first"; "items written at the same instant are never skipped across pages"; "pages with before: no overlap, a string cursor, and the last page has none".
  - `apps/api/test/appointments.test.ts`: "an inspection on a lead job books it, moves the job to Inspection and logs both lines"; "a PATCH that moves the times adds a "moved to" line and an audit row".
  - `apps/api/test/quotes.test.ts`: "v1 default roof: 201, Q-0001, draft, the ported total, and the activity line on the job".
  - `apps/web/test/timeline.test.tsx`: "timeline renders items newest first"; "a note posts and appears at the top"; "a text shows its direction and its message status".

## Calendar
- **Appointments are created, moved, completed and canceled in week, day and agenda views**
  - `apps/api/test/appointments.test.ts`: "a PATCH that moves the times adds a "moved to" line and an audit row"; "cancel, complete and no-show each set the status, add a line and write an audit row"; "a canceled appointment leaves the list unless includeCanceled is set".
  - `apps/web/test/calendar.test.tsx`: "week renders appointments at the right rows for Chicago while TZ is UTC"; "next, day view and today move the window"; "agenda on phone"; "clicking an appointment opens it"; "canceled hidden until Show canceled toggled"; "DST week of 2026-11-01 positions".
  - `apps/web/test/appointments-form.test.tsx`: "save posts the right body with ISO instants from company-zone input"; "reschedule PATCHes the new start with the same length"; "install shows a date range and posts all-day".
  - `apps/web/test/appointments.test.tsx`: "Mark done posts /complete"; "Cancel asks to confirm then posts /cancel (nothing posted before confirming)"; "Reschedule calls onReschedule".
- **Booking an inspection on a lead moves the job**
  - `apps/web/e2e/calendar.spec.ts`: "book an inspection from a lead in 3 clicks and the job moves".
  - `apps/api/test/appointments.test.ts`: "an inspection on a lead job books it, moves the job to Inspection and logs both lines"; "an inspection on a job already in proposal books it but does not move the job".
  - `apps/web/test/appointments-form.test.tsx`: "prefills the customer and home from ?jobId=&kind=inspection"; "toasts when the job moved".
- **Suggested times respect work hours, buffers and minimum notice**
  - `apps/api/test/availability.test.ts`: "Sunday 2026-11-01 has no default hours; Monday 2026-11-02 starts at 08:00 CST (14:00Z)"; "a visit at another home: no start from 09:00 to 11:00 is offered, but 08:30 and 11:30 are"; "the same home has no buffer: 09:00 and 11:00 are offered, 10:00 and 10:30 are not"; "at 09:00 with two hours of notice nothing before 11:00 is offered; after the owner allows zero notice, 09:00 is".
  - `packages/shared/test/availability.test.ts`: "a free Monday in Chicago gives 19 hourly-stepped 60-minute starts from 08:00 to 17:00"; "a busy item at another home blocks 09:00 to 11:00 starts with a 30-minute buffer"; "minimum notice of 120 minutes at 08:15 local starts the first slot at 10:30"; "a slot must fit inside one work interval, so none straddles lunch"; "Sunday has no slots with the default hours".
  - `apps/web/test/appointments-suggest.test.tsx`: "SuggestedTimes shows the next 5 slots as buttons in the company zone".
- **Reps see only their own and their jobs' appointments**
  - `apps/api/test/appointments.test.ts`: "a rep sees their own appointments and those on jobs they can see, not the other rep's on a hidden job"; "a rep cannot read, change or cancel an appointment they cannot see (404)"; "a rep cannot assign an appointment to another member".
  - `apps/api/test/availability.test.ts`: "a rep asking for another member is refused with 403".
  - `apps/web/test/calendar.test.tsx`: "reps see no people picker".

## Sync (CI, with recorded fakes)
- **A Roofline appointment appears in the person's Google and Outlook calendar**
  - `apps/web/e2e/calendar.spec.ts`: "connect a calendar, and appointments sync both ways" (the outbound direction and the "On your Google calendar" state; the inbound direction is not driven from the browser, Ruling 9).
  - `apps/api/test/calendar-push.test.ts`: "create pushes one event with the expected text and no phone or email".
  - `apps/api/test/google-calendar.test.ts`: "creates a timed event in the company zone with the Roofline marker"; "creates an all-day event as calendar dates with an exclusive end".
  - `apps/api/test/microsoft-calendar.test.ts`: "createEvent timed sends UTC times and the Roofline marker"; "createEvent all-day sends local midnights in the company zone".
  - `apps/web/test/appointments.test.tsx`: "synced shows On your Google calendar for a google connection and On your Outlook calendar for microsoft".
- **...and moves and disappears with it**
  - `apps/api/test/calendar-push.test.ts`: "moving the appointment updates the same event"; "canceling deletes the event and the link"; "reassigning from Sam to Pat moves the event"; "a newer external change is not overwritten on a 412 conflict".
  - `apps/api/test/appointments.test.ts`: "an assigned appointment queues one calendar-push per create, PATCH and cancel"; "an unassigned appointment queues no calendar-push".
  - `apps/api/test/google-calendar.test.ts`: "patches an event with its etag in If-Match and returns the new etag"; "deletes an event and treats a missing event as already deleted".
  - `apps/api/test/microsoft-calendar.test.ts`: "updateEvent sends If-Match and returns the new etag"; "deleteEvent treats 204 and 404 as done and 503 as unavailable".
- **An external move or delete is applied within one pull (Ruling 9)**
  - `apps/api/test/calendar-pull.test.ts`: "an external move of a linked event moves the appointment and writes an activity"; "an external delete cancels the appointment and removes the link"; "our own push echo is skipped"; "an older external change is ignored"; "a connection is due after five minutes"; "pulls once then returns 202 without pulling inside 30 seconds".
  - `apps/api/test/calendar-fake.test.ts`: "an external move shows in the next sync with a later updatedAt and the new start"; "an external delete shows as cancelled".
  - `apps/api/test/google-calendar.test.ts`: "runs a full sync across pages, then an incremental sync from the cursor". `apps/api/test/microsoft-calendar.test.ts`: "full sync follows nextLink and maps events"; "incremental sync uses the stored delta link".
- **Outside events become busy blocks with no titles stored**
  - `apps/api/test/calendar-pull.test.ts`: "an outside event becomes one busy block with times only"; "a transparent event creates no block"; "cursor expiry replaces the busy blocks with the full set".
  - `apps/api/test/calendar-fake.test.ts`: "addOutsideEvent appears in a sync as busy".
  - `apps/api/test/availability.test.ts`: "a calendar busy block blocks its time and the buffer the same way".
  - `apps/web/test/calendar.test.tsx`: "busy blocks show Busy".
- **A broken token shows "Reconnect your calendar"**
  - `apps/api/test/calendar-tokens.test.ts`: "a revoked grant throws CalendarAuthError and marks the connection for reconnecting".
  - `apps/api/test/calendar-connect.test.ts`: "a revoked grant turns the connection to error once".
  - `apps/api/test/calendar-push.test.ts`: "a revoked token marks the connection error and the appointment failed, without throwing".
  - `apps/api/test/calendar-pull.test.ts`: "a revoked token marks the connection error and the tick continues".
  - `apps/web/test/calendar-connection.test.tsx`: "an error connection shows the reconnect banner".
  - `apps/web/test/appointments.test.tsx`: "failed sync shows Couldn't update your calendar and Try again re-saves the same times".
- **The `connect_calendar` checklist item turns done**
  - `apps/api/test/setup.test.ts`: "connect_calendar turns done after one member connects a calendar"; "a calendar in error does not count"; "another company's calendar connection does not mark this company done".
  - `apps/api/test/calendar-connect.test.ts`: "the callback saves an encrypted connection, picks the primary calendar, audits and redirects".
- **Connecting and credentials** (supports the bullets above)
  - `apps/web/e2e/calendar.spec.ts`: "connect a calendar, and appointments sync both ways".
  - `apps/api/test/calendar-connect.test.ts`: "connect redirects to the provider with a signed state"; "a state minted for another user is refused"; "a reused state is refused"; "company B cannot touch company A connection".
  - `apps/api/test/calendar-tokens.test.ts`: "a refresh token returned by the provider is stored encrypted, and used next time".

## Search
- **Command-K finds customers, jobs and addresses**
  - `apps/api/test/search.test.ts`: "finds customers, jobs and addresses"; "an address is also found by its city or ZIP; a customer by the digits of a phone number"; "scopes a rep to what they may see".
  - `apps/web/test/search-dialog.test.tsx`: "opens on Ctrl+K even from a text field"; "groups results and opens the active one with Enter"; "opens a job and an address from the keyboard".
  - `apps/web/e2e/crm.spec.ts`: "a new job from the map home in 2 clicks to its form" (opens the search and picks New job).
- **...and offers the actions**
  - `apps/web/test/search-actions.test.tsx`: "lists matching actions under Actions"; "opens New job and Book an inspection with the keyboard"; "offers the customers download to %s"; "does not offer the customers download to a rep".
- **Recents show on an empty query**
  - `apps/web/test/search-actions.test.tsx`: "lists recents on an empty query and opens one"; "survives a storage error".
  - `apps/web/test/recents.test.tsx`: "lists the newest first"; "keeps at most eight entries"; "keeps each company in its own key".

## Pricebook, quotes and PDF
- **The owner edits prices**
  - `apps/api/test/pricebook.test.ts`: "the owner saves a change, GET returns it as the company pricebook, and the change is audited"; "office cannot save the pricebook (403)"; "a rep cannot save the pricebook (403)"; "a price above 100,000 is refused and names its field".
  - `apps/web/test/settings-prices.test.tsx`: "owner saves prices in dollars"; "office sees prices read-only".
- **A quote prices identically to the ported engine**
  - `packages/shared/test/pricing.test.ts`: "surface measurements are not pitched twice"; "orders complete bundles and calculates labor on actual area"; "tax applies to marked-up materials only, money reconciles"; "additional layers, slope and height increase the correct labor costs".
  - `apps/api/test/quotes.test.ts`: "v1 default roof: 201, Q-0001, draft, the ported total, and the activity line on the job".
  - `apps/web/test/quote-editor.test.tsx`: "shows the live total equal to calculateQuote for the default scope".
  - `apps/web/e2e/crm.spec.ts`: "a quote prices, goes final and downloads a PDF".
- **Mark final freezes it**
  - `apps/api/test/quotes.test.ts`: "a final quote keeps its old prices after the pricebook changes; a new quote uses the new ones"; "a final quote cannot be patched: 409 with the plain sentence"; "a final quote cannot be finalized again: 409 with the same sentence"; "finalize sets the job value when it was empty, and says so on the job".
  - `apps/web/test/quote-editor.test.tsx`: "makes the inputs read-only and shows Copy when the quote is final"; "marks a quote final after the confirm".
  - `apps/web/e2e/crm.spec.ts`: "a quote prices, goes final and downloads a PDF".
- **The PDF downloads with the quote's numbers**
  - `apps/web/e2e/crm.spec.ts`: "a quote prices, goes final and downloads a PDF" (file `Q-0001-roofing-estimate.pdf`).
  - `apps/api/test/quote-pdf.test.ts`: "the owner gets a draft as a PDF attachment named after the quote number"; "a final quote also returns a PDF"; "the assigned rep gets the PDF; a rep without the job gets 404".
  - `apps/api/test/quote-pdf-render.test.ts`: "a draft starts with the PDF header and shows the number, total, dates and footer"; "a draft says it is not final; a final quote says Final and not the draft line".
  - `apps/web/test/quote-editor.test.tsx`: "links the PDF download to the quote pdf route".

## Export
- **customers.csv and jobs.csv download with formula-safe cells**
  - `apps/api/test/export.test.ts`: "headers and one row each are exact"; "a name that starts with a formula is neutralized"; "a rep is refused on both files; an office user gets both"; "every export writes an audit row".
  - `packages/shared/test/csv.test.ts`: "guards and quotes a leading CR"; "does not guard text that merely contains formula characters"; "passes headers through the formula guard".
  - `apps/web/test/customers-list.test.tsx`: "an owner sees the Download customers link; a rep does not".
- **...also in read-only mode**
  - `apps/api/test/export.test.ts`: "read-only mode (trial ended) still exports both files".

## Today
- **Shows today's appointments and due follow-ups**
  - `apps/api/test/today.test.ts`: "the rep sees only their own non-canceled appointments for today in Chicago"; "a rep's follow-ups are their visible jobs due today or earlier, not later ones or another rep's"; "2026-03-08 (clocks go forward): 00:30 and 23:30 are today, the next day 00:30 is not"; "2026-11-01 (clocks go back): 00:30 and 23:30 are today, the next day 00:30 is not".
  - `apps/web/test/today-crm.test.tsx`: "lists appointments and follow-ups from /api/today"; "hides Follow up today when there are none and shows the empty line".
  - `apps/web/e2e/today.spec.ts`: "opens once per day, again the next day" (the Today window itself; the CRM lists are covered by the two files above).

## Phone
- **The Jobs list, the job and customer windows and the agenda work at 375x812 with no horizontal scroll**
  - `apps/web/e2e/phone.spec.ts`: "C1 pages do not scroll sideways" (the Jobs list, a job, a customer and the calendar agenda).
  - `apps/web/test/jobs-board.test.tsx`: "phone shows the list".
  - `apps/web/test/calendar.test.tsx`: "agenda on phone".
  - `apps/web/test/phone.test.tsx`: "windows are pages on a phone"; "shows five bottom tabs and no dock on a phone".

## UI rules
- **Copy-rules pass, and no vendor name outside `copy/connections.ts`**
  - `apps/web/test/copy-rules.test.ts`: "uses no technical words"; "uses no enum tokens"; "names vendors only where connecting accounts or paying"; "finds strings in every copy file".
  - `apps/web/test/lint-rules.test.ts`: "refuses text written in JSX"; "refuses a raw button in the web app".
- **The 12px rule passes**
  - `packages/ui/test/min-font-size.test.ts`: "rejects %s as too small"; "only a var(--font-size-*) token passes; any other var() is reported"; "checks the definition of every --font-size-* token, so the var() passthrough is honest".
  - `packages/ui/test/tokens.test.ts` (token sizes).
- **Axe passes (no serious or critical violations) on the board, the job window, the customer window and the calendar week view**
  - `apps/web/e2e/a11y.spec.ts`: "jobs board has no serious accessibility violations"; "job window has no serious accessibility violations"; "customer window has no serious accessibility violations"; "calendar week has no serious accessibility violations".
  - Keyboard use of the calendar grid: `apps/web/test/calendar.test.tsx`: "arrow keys move focus between appointments and Enter opens the focused one"; "empty slots are reached by pointer, not Tab, and are named by their day and time".

## Click counts (spec section 12, for the record)
- **A new job from the map home in 2 clicks to its form (limit 3)**: `apps/web/e2e/crm.spec.ts`: "a new job from the map home in 2 clicks to its form".
- **An inspection booked from a job in 3 clicks**: `apps/web/e2e/calendar.spec.ts`: "book an inspection from a lead in 3 clicks and the job moves".

## Manual smoke (real calendars)
- **Connect a real Google and a real Outlook calendar; create, move and cancel in both directions**
  - Manual: `docs/superpowers/c1-manual-smoke.md` (Task 29's runbook, parked for the owner). Nothing in CI reaches a live provider; the adapters are tested against recorded JSON through an injected `fetch`, and the end-to-end stack uses the fake calendar (`FAKE_PROVIDERS=1`).

## Gaps
- **Inbound sync in the browser:** the end-to-end tests do not drive an external move or delete (Ruling 9). It is covered by `calendar-pull.test.ts` and `calendar-fake.test.ts` at the API level only.
- **Vendor names:** `copy-rules.test.ts` allows vendor names in `auth.ts`, `billing.ts`, `connections.ts`, `legal.ts` and `setup.ts` (the `VENDOR_FILES` list), which is wider than the spec's "outside `copy/connections.ts`". No test pins it to `connections.ts` alone.
- **Keyboard "Move to..." menu:** the menu is covered by component tests of the move itself, and axe runs on the board, but no test walks the menu with the keyboard alone.
- **Axe per-state:** axe runs on the page states in `a11y.spec.ts` (seeded data); it does not open the new-appointment form or the quote editor.

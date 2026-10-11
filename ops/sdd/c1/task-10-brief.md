### Task 10: Google Calendar adapter

**Base:** `c1-crm` after Task 5 is merged. From T5 (`providers/calendar.ts`): `CalendarApi`, `OAuthTokens`, `ExternalCalendar`, `ExternalEventInput`, `ExternalEvent`, `SyncPage`, `CalendarUnavailableError`, `CalendarAuthError`; the stub `providers/google-calendar.ts` (`googleCalendarFor(config): CalendarApi | null`, already called by `createCalendarApis`). Config `GOOGLE_CLIENT_ID` (F1) + `GOOGLE_CLIENT_SECRET` (T5). Fixture style: F3 T25's `apps/api/test/twilio-fixtures.ts` (`fixtureFetch`) is the pattern — write a local `calendarFixtureFetch` in the test file; do not import Twilio helpers.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:** Builder 1 `google-calendar.ts` (OAuth and tokens); Builder 2 `google-calendar.ts` (events and sync; bottom half, the lead joins); Builder 3 fixtures and tests.

**Files:**
- Create: `apps/api/test/fixtures/google-calendar/{token-exchange,token-refresh,token-invalid-grant,userinfo,calendar-list,event-insert,event-patch,event-get,events-sync-full,events-sync-incremental,events-sync-gone}.json`
- Modify: `apps/api/src/providers/google-calendar.ts` (replace the stub)
- Test: `apps/api/test/google-calendar.test.ts`

**Interfaces:**
```ts
export class GoogleCalendarApi implements CalendarApi { constructor(o: { clientId: string; clientSecret: string; fetch?: typeof fetch; timeoutMs?: number }) }
export function googleCalendarFor(config: Config): CalendarApi | null;   // GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET → GoogleCalendarApi; else null
export const GOOGLE_CALENDAR_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'];
```
- **OAuth:** `authUrl` → `https://accounts.google.com/o/oauth2/v2/auth?client_id&redirect_uri&response_type=code&scope=<space-joined>&access_type=offline&prompt=consent&include_granted_scopes=true&state`; `exchangeCode` → `POST https://oauth2.googleapis.com/token` (form) then `GET https://openidconnect.googleapis.com/v1/userinfo` for the email; `refresh` → token POST with `grant_type=refresh_token`; `invalid_grant` → `CalendarAuthError("Reconnect your calendar.")`.
- **Calendars:** `GET https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer` → `ExternalCalendar[]`.
- **Events:** `POST /calendars/{id}/events` (`summary`, `location`, `description`, `start`/`end` as `{dateTime, timeZone}` or `{date}` for all-day with an exclusive end date, `transparency: 'opaque'`, `extendedProperties.private.roofline = 'appointment'`); `PATCH …/events/{eventId}` with `If-Match: <etag>` (412 → `'conflict'`, 404/410 → `'gone'`); `DELETE` (404/410 fine); `GET` one.
- **Sync:** `GET …/events?singleEvents=true&showDeleted=true&maxResults=250` with `syncToken=<cursor>` (incremental) or `timeMin`/`timeMax` from the window (full); follow `nextPageToken`; the last page's `nextSyncToken` is `nextCursor`; HTTP 410 → restart full with `fullResync: true`. Map `status: 'cancelled'` → `cancelled`, `transparency: 'transparent'` → `busy: false`, `updated` → `updatedAt`.
- **Errors:** 401 → refresh once is the caller's job (Task 12's `accessTokenFor`); here 401/403 → `CalendarAuthError`; 429/5xx/network/timeout (10 s) → `CalendarUnavailableError("Couldn't reach Google Calendar.")` — **the message is never shown in the UI** (UI strings live in copy); tokens and event bodies never appear in an error.

**Tests:**
- (an injected `fetch` serving the fixtures and recording requests): the auth URL params; exchange + userinfo → tokens with the email; refresh; `invalid_grant` → `CalendarAuthError`; calendar list mapping; insert body for a timed and an all-day event (exclusive end date); patch with `If-Match` and the 412/410 mappings; full then incremental sync (cursor carried, pages followed, cancelled and transparent mapped); 410 → `fullResync`; 503 → `CalendarUnavailableError` whose message has no token.

**Carries and rulings:**
- The `CalendarUnavailableError` message is server text and never reaches the UI; tokens and event bodies never appear in any error or log.

**Verify notes:**
- CI.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint` plus focused pure tests; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(calendar): Google Calendar adapter with incremental sync`

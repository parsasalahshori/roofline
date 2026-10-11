### Task 11: Microsoft Graph adapter

**Base:** `c1-crm` after Task 5 is merged. Same seam as Task 10; the stub `providers/microsoft-calendar.ts` (`microsoftCalendarFor(config)`); config `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET` (T5).

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:** as Task 10.

**Files:**
- Create: `apps/api/test/fixtures/microsoft-calendar/{token-exchange,token-refresh,token-invalid-grant,me,calendars,event-create,event-patch,event-get,delta-full,delta-incremental,delta-gone}.json`
- Modify: `apps/api/src/providers/microsoft-calendar.ts` (replace the stub)
- Test: `apps/api/test/microsoft-calendar.test.ts`

**Interfaces:**
```ts
export class MicrosoftCalendarApi implements CalendarApi { constructor(o: { clientId: string; clientSecret: string; fetch?: typeof fetch; timeoutMs?: number }) }
export function microsoftCalendarFor(config: Config): CalendarApi | null;   // MICROSOFT_CLIENT_ID + MICROSOFT_CLIENT_SECRET → MicrosoftCalendarApi; else null
export const MICROSOFT_CALENDAR_SCOPES = ['offline_access', 'User.Read', 'Calendars.ReadWrite'];
```
- **OAuth:** `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` / `/token`; `GET https://graph.microsoft.com/v1.0/me` (`mail ?? userPrincipalName`); `invalid_grant` → `CalendarAuthError`.
- **Calendars:** `GET /me/calendars?$select=id,name,isDefaultCalendar,canEdit`.
- **Events:** `POST /me/calendars/{id}/events` (`subject`, `body {contentType:'text'}`, `location {displayName}`, `start/end {dateTime, timeZone}` — all-day with `isAllDay: true` and midnight times, `showAs: 'busy'`, `singleValueExtendedProperties` marking Roofline); `PATCH /me/events/{id}` with `If-Match` (`@odata.etag`); 412 → `'conflict'`, 404 → `'gone'`; `DELETE`.
- **Sync:** `GET /me/calendars/{id}/calendarView/delta?startDateTime&endDateTime` (full) or the stored `@odata.deltaLink` (incremental), header `Prefer: odata.maxpagesize=200`; follow `@odata.nextLink`; `@removed` → `cancelled`; `showAs: 'free'` → `busy: false`; `lastModifiedDateTime` → `updatedAt`; HTTP 410 or `syncStateNotFound` → full with `fullResync: true`.
- **Errors:** as Task 10 ("Couldn't reach Outlook.").

**Tests:**
- mirror Task 10's list for Graph shapes, including `@removed` and the delta link as cursor.

**Carries and rulings:**
- Mirror Task 10's test list; the delta link is the cursor.

**Verify notes:**
- CI.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint` plus focused pure tests; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(calendar): Outlook calendar adapter with delta sync`

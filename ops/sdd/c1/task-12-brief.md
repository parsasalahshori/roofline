### Task 12: Calendar connect and the setup item

**Base:** `c1-crm` after Tasks 4 and 5 are merged; F3 **Task 16** (setup checklist API: `setupFacts`, `GET /api/setup`) must be in `f3-setup`. From F3 T4 (`packages/shared/src/setup.ts`): `SetupFacts`, `deriveSetup`, `COMING_WITH` (has `'calendar'`), `FOUNDATION_ITEMS`. From F3 T16 (`packages/db/src/repos/setup.ts`): `setupFacts(tx, ctx)`; test `apps/api/test/setup.test.ts`. From T5: `CalendarApis`, `deps.calendars`, `FakeCalendarApi`, stub `routes/calendar-connect.ts` (`calendarConnectRoutes`), stub `calendar/pull.ts`. From F1: `encrypt`/`decrypt` (`packages/db/src/crypto.ts`), `audit`, `company_members` view. Session: `req.ctx` (`TenantContext`) and `req.session` (`companyId`, `userId`) from `auth/middleware.ts`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:**
- Builder 1: `apps/api/src/calendar/{oauth-state,tokens}.ts` and `packages/db/src/repos/calendar.ts` (connections).
- Builder 2: `apps/api/src/routes/calendar-connect.ts`.
- Builder 3: `packages/shared/src/setup.ts` + `packages/db/src/repos/setup.ts` (the `connect_calendar` rule) and the tests.

**Files:**
- Create: `apps/api/src/calendar/{oauth-state,tokens}.ts`
- Modify: `packages/db/src/repos/calendar.ts`, `apps/api/src/routes/calendar-connect.ts`, `packages/shared/src/setup.ts`, `packages/db/src/repos/setup.ts`
- Test: `apps/api/test/calendar-connect.test.ts`, `packages/shared/test/setup.test.ts` (extend), `apps/api/test/setup.test.ts` (extend)

**Interfaces:**
```ts
// calendar/oauth-state.ts — signed with HMAC-SHA256 over ENCRYPTION_KEY-derived key; single use via an in-row nonce
export function makeOAuthState(i: { companyId: string; userId: string; provider: CalendarProvider; now: Date }, key: string): string;   // base64url(json).sig, 10-minute expiry
export function readOAuthState(state: string, key: string, now: Date): { companyId: string; userId: string; provider: CalendarProvider } | null;
// repos/calendar.ts (connections only; links are Task 13's calendar-links.ts, busy blocks Task 14's calendar-busy.ts)
export type CalendarConnectionRow = typeof calendarConnections.$inferSelect;
export async function getConnection(tx: Tx, ctx: TenantContext, userId: string): Promise<CalendarConnectionRow | null>;
export async function saveConnection(tx: Tx, ctx: TenantContext, c: { userId: string; provider: CalendarProvider; accountEmail: string; encryptedCredentials: Buffer; scopes: string[]; calendarId: string; calendarName: string }, now: Date): Promise<CalendarConnectionRow>;   // upsert on (company_id, user_id); resets cursor, status connected
export async function setConnectionCalendar(tx: Tx, ctx: TenantContext, userId: string, calendarId: string, calendarName: string, now: Date): Promise<void>;   // resets cursor and busy blocks
export async function markConnectionError(tx: Tx, ctx: TenantContext, connectionId: string, errorPlain: string, now: Date): Promise<void>;
export async function deleteConnection(tx: Tx, ctx: TenantContext, userId: string): Promise<boolean>;   // busy blocks and links cascade
export async function connectedMemberCount(tx: Tx, ctx: TenantContext): Promise<number>;   // status 'connected' and the member active (company_members)
// calendar/tokens.ts
export async function accessTokenFor(deps: AppDeps, ctx: TenantContext, conn: CalendarConnectionRow): Promise<string>;   // decrypt, api.refresh, cache in memory until expiry − 60 s; CalendarAuthError → markConnectionError(..., 'Reconnect your calendar.') then rethrow
```
- **Routes (`calendar-connect.ts`, any member, for themselves):**
  - `GET /api/calendar/connection` → `CalendarConnectionView` (with `configured` per provider).
  - `GET /api/calendar/connect/:provider` → 302 to `api.authUrl({ state, redirectUri })`, `redirectUri = ${PUBLIC_BASE_URL}/api/calendar/oauth/${provider}/callback`; unconfigured → 302 to `${APP_ORIGIN}/settings/connections?calendar=not-set-up`.
  - `GET /api/calendar/oauth/:provider/callback?code&state[&error]` → state must match the session's company and user (else `?calendar=failed`); `exchangeCode`; `listCalendars` → the primary writable one; `saveConnection` with `encrypt(JSON.stringify({ refreshToken }), ENCRYPTION_KEY)`; audit `calendar.connected { provider }`; activity none; 302 to `${APP_ORIGIN}/settings/connections?calendar=connected`. A user `error=access_denied` → `?calendar=canceled`.
  - `GET /api/calendar/connection/calendars` → `ExternalCalendar[]` (writable only); `PATCH /api/calendar/connection { calendarId }` (must be in that list) → view.
  - `DELETE /api/calendar/connection` → 204; audit `calendar.disconnected`.
  - `POST /api/calendar/sync` → queues an immediate pull for the caller (Task 14 fills the function it calls: `pullConnection(deps, ctx, conn)`; until then a no-op) → 202.
- **Setup (`connect_calendar`):** `SetupFacts` gains `calendarsConnected: number`; `deriveSetup`: `connect_calendar` is `done` when `calendarsConnected > 0`, else `todo`, with `comingWith: null` (it is no longer a later-spec item; `COMING_WITH` keeps `calendar` only if still used elsewhere — remove it otherwise and update the tests); `progress.total` stays 5 (`FOUNDATION_ITEMS` unchanged). `setupFacts` fills it with `connectedMemberCount`.

**Tests:**
- connect → 302 to the fake auth URL with a state; callback with the fake code saves a connection (token stored encrypted; decrypts to the refresh token), picks `primary`, audits, redirects `?calendar=connected`; a state for another user or company, an expired state (clock +11 min) and a reused state → `?calendar=failed`; change calendar; disconnect; `accessTokenFor` after `revoke` → connection `error` with "Reconnect your calendar."; `GET /api/setup` shows `connect_calendar` done after one connection; shared `deriveSetup` tests updated.

**Carries and rulings:**
- **Ruling CC:** keep `'calendar'` in `COMING_WITH` (now unused) so `copy/setup.ts` (`Record<ComingWith, …>`, T25's file) still compiles; `connect_calendar` just stops returning it. Cost: one dead enum value.
- The only C1 edits to `packages/shared/src/setup.ts` and `packages/db/src/repos/setup.ts` are this task's.
- Google sign-in (F1) and calendar connect share `GOOGLE_CLIENT_ID`; the calendar redirect URI `<PUBLIC_BASE_URL>/api/calendar/oauth/google/callback` must be registered on that OAuth client (owner item, README in T28).

**Verify notes:**
- CI; `npx vitest run --project @roofline/shared setup` locally.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint` plus focused pure tests; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(calendar): connect a Google or Outlook calendar per person; the checklist item turns real`

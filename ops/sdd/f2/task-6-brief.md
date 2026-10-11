### Task 6: API: serve the web app, CSP, today-shown, rerun link, body limit

**Files:**
- Create: `apps/api/src/web.ts`, `apps/api/src/auth/me.ts`, `packages/db/src/system/me.ts`
- Modify:
  - `apps/api/src/app.ts` (CSP, mount `/api/me`, approvals body limit, `serveWeb`)
  - `apps/api/src/config.ts` (`WEB_DIST_DIR`)
  - `apps/api/src/tasks/service.ts` (`rerunOfTaskId` on `TaskView`)
  - `packages/db/src/system/index.ts`
  - `packages/shared/src/time-zone.ts` (`localDate`)
  - `.env.example`, README ("Run it locally")
- Test: `apps/api/test/web.test.ts`, `apps/api/test/me.test.ts`, `packages/shared/test/time-zone.test.ts` (extend the existing file if there is one), `apps/api/test/approvals-approve.test.ts` (extend)

**Interfaces:**
- **Shared:** `localDate(now: Date, zone: string): string` returns the `YYYY-MM-DD` calendar day in that zone. Use `Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })`.
- **db/system:**
  - `markTodayShown(system: Db, companyId: string, userId: string, now: Date): Promise<boolean>`
  - One statement: `update memberships m set last_today_shown_on = $today, updated_at = now() from companies c where c.id = m.company_id and m.company_id = $1 and m.user_id = $2 and m.status = 'active' and m.last_today_shown_on is distinct from $today returning m.id`. `$today` is `localDate(now, c.timezone)`.
  - Read the zone first in the same transaction (`select timezone from companies where id = $1`), then update.
  - Returns true when a row changed. That is atomic across tabs.
- **API:**
  - `POST /api/me/today-shown` → `200 { show: boolean }` for any signed-in member (rep included). It is mounted with `app.use('/api/me', meRoutes(deps))`.
  - `TaskView.rerunOfTaskId: string | null`: the column already exists; add it to the view builder.
  - `Config.WEB_DIST_DIR?: string`: optional; when set it must be an existing directory containing `index.html`, otherwise a `ConfigError` naming the key.
  - `serveWeb(app: Express, distDir: string): void`, mounted after the `/api` routers and before `notFoundHandler`:
    - `express.static(distDir, { index: false })`, where `/assets/*` gets `Cache-Control: public, max-age=31536000, immutable`
    - an SPA fallback for `GET`/`HEAD` whose path does not start with `/api`, `/hooks` or `/health` and does not look like a file (`/\.[a-z0-9]+$/i` → 404): send `index.html` with `Cache-Control: no-cache`
  - **Body limit:** `app.use('/api/approvals', express.json({ limit: '1mb' }))`, mounted before the global 256 KB parser (F1 follow-up: a 5,000-recipient payload is about 200 KB).
- **CSP:** replace `helmet()` with `helmet({ contentSecurityPolicy: { directives: {...} } })`:
  - `default-src 'self'`
  - `script-src 'self'`
  - `style-src 'self' 'unsafe-inline'`
  - `img-src 'self' data: blob: https://api.maptiler.com https://tile.openstreetmap.org`
  - `connect-src 'self' https://api.maptiler.com https://tile.openstreetmap.org`
  - `font-src 'self' data:`
  - `worker-src 'self' blob:`
  - `child-src blob:`
  - `frame-ancestors 'none'`
  - `object-src 'none'`
  - `base-uri 'self'`
  - `form-action 'self'`
  - `upgrade-insecure-requests` only when `NODE_ENV=production` (pass `upgradeInsecureRequests: null` otherwise). The e2e stack is plain http on 127.0.0.1.
  - Keep helmet's other default headers.
- **Docs:**
  - `.env.example`: document that in development the browser's origin is Vite's (`APP_ORIGIN=http://127.0.0.1:4401`), and add `WEB_DIST_DIR` (production: `apps/web/dist`).
  - README "Run it locally": `npm run db:up`, `npm run db:migrate`, `npm run set-role-passwords -w @roofline/db`, `npm run seed:dev -w @roofline/api` (Task 9), `npm run dev:api`, `npm run dev:worker`, `npm run dev:web`, then open http://127.0.0.1:4401.

- [ ] **Step 1: Write the failing tests**

`time-zone.test.ts`:
- `localDate(new Date('2026-10-12T04:30:00Z'), 'America/Chicago') === '2026-10-11'`
- the same instant in `'Asia/Tokyo'` → `'2026-10-12'`

`me.test.ts` (`makeTestApp`, `loginAs`):
- `it('shows Today once per company day')`:
  - `clock.set('2026-10-12T14:00:00Z')` → POST → `{show:true}`; a second POST → `{show:false}`.
  - `clock.set('2026-10-13T04:00:00Z')` is still Oct 12 in Chicago → `{show:false}`.
  - `clock.set('2026-10-13T06:00:00Z')` → `{show:true}`.
- `it('keeps each member separate')`: office's POST is unaffected by owner's.
- `it('needs a session')`: 401.
- `it('refuses a cross-site origin')`: `Origin: https://evil.example` → 403.

`web.test.ts` (`makeTestApp({ WEB_DIST_DIR: tmpDirWithIndexAndAsset })`):
- `GET /` and `GET /approvals/abc` → 200, `text/html`, the body equals `index.html`, `cache-control: no-cache`
- `GET /assets/app-123.js` → 200 with `immutable`
- `GET /assets/missing.js` → 404
- `GET /api/nope` → 404 JSON `{ error: "We couldn't find that." }`, not HTML
- `GET /health` → `{ ok: true }`
- the `content-security-policy` header contains `worker-src 'self' blob:` and `https://api.maptiler.com`
- without `WEB_DIST_DIR`, `GET /` → 404 JSON

`config.test.ts`: `WEB_DIST_DIR` pointing at a missing directory → `ConfigError` whose message names `WEB_DIST_DIR`.

`approvals-approve.test.ts`: `it('carries the plan it was rerun from')`: after `POST /:id/rerun`, the new view's `rerunOfTaskId === oldId`, and an ordinary task's is `null`. Also `it('accepts an edit body over 256 KB on approvals')`: a PATCH with a 300 KB payload string gets the step's own validation error (400 naming `payload…`), not 413.

- [ ] **Step 2: Run them and see them fail** — `npx vitest run --project @roofline/api --project @roofline/shared`.
- [ ] **Step 3: Implement** (signatures above).
- [ ] **Step 4: Run the full suite and lint** — `npm run lint && npm run typecheck && npx vitest run`. Expected: PASS (the F1 count plus the new tests).
- [ ] **Step 5: Commit** — `feat(api): serve the web app with a map-ready CSP, today-shown, rerun link`

---


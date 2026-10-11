### Task 28: End-to-end tests, the acceptance map and the docs

**Base:** `c1-crm` after Tasks 6–27 are merged; F3 **Task 36** (which merges F2 T13 + T18 e2e into `f3-setup`: `apps/web/e2e/{stack,fixtures,phone.spec,a11y.spec}.ts`, fixtures `loginAs`, `clicks`, `click`, `markTodaySeen`, `resetScenario`) must be in. From T5: `providers/fakes/calendar.ts` (this task changes `authUrl` under `FAKE_PROVIDERS`). The stack already runs with `FAKE_PROVIDERS=1`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:** Builder 1 `apps/web/e2e/crm.spec.ts`; Builder 2 `apps/web/e2e/calendar.spec.ts` plus the `phone.spec.ts` and `a11y.spec.ts` additions; Builder 3 `docs/superpowers/c1-acceptance.md` and README updates.

**Files:**
- Create: `apps/web/e2e/{crm,calendar}.spec.ts`, `docs/superpowers/c1-acceptance.md`
- Modify: `apps/web/e2e/phone.spec.ts`, `apps/web/e2e/a11y.spec.ts`, `README.md` ("Running in production": calendar OAuth env and redirect URIs `<PUBLIC_BASE_URL>/api/calendar/oauth/google/callback` and `/microsoft/callback`)

**Tests** (stack with `FAKE_PROVIDERS=1`, the fake calendar; owner unless stated; `markTodaySeen`):
- `crm.spec.ts`: `test('the board shows the showcase pipeline')` (column counts 8/7/6/4/2, Lost 1); `test('drag a lead to Inspection, then Lost asks why')`; `test('a new job from the map home in 2 clicks to its form')` (⌘K "New job" → form; `clicks.count <= 2`), then create it with a new customer and address → the job window, the pin appears on the map; `test('the timeline shows a note, a stage move and a quote')`; `test('a quote prices, goes final and downloads a PDF')` (`waitForEvent('download')`, filename `Q-0001-roofing-estimate.pdf`); `test('a rep sees only their jobs')` (login rep).
- `calendar.spec.ts`: `test('book an inspection from a lead in 3 clicks and the job moves')` (job window → Book inspection → first suggestion → Save; `clicks.count === 3`; job stage Inspection); `test('connect a calendar, and appointments sync both ways')` (Settings → Connections → Connect Google → the fake auth URL is followed by a test-only redirect to the callback with `code=fake` — implement the fake's `authUrl` to point at `${PUBLIC_BASE_URL}/api/calendar/oauth/google/callback?code=fake&state=…` when `FAKE_PROVIDERS` so the browser round-trip works; then an appointment's detail shows "On your Google calendar"; the inbound direction is not driven from the browser (Ruling 9) and is mapped to Task 14's integration tests in the acceptance map). The fake's `authUrl` change (pointing straight at the callback with `code=fake` when `FAKE_PROVIDERS` is on) is made in `providers/fakes/calendar.ts` by this task.
- `phone.spec.ts` (append): `/jobs` (list view), `/jobs/<id>`, `/customers/<id>`, `/calendar` (agenda) → `scrollWidth <= 375`.
- `a11y.spec.ts` (append): `/jobs`, `/jobs/<id>`, `/customers/<id>`, `/calendar?view=week` → no serious or critical violations.
- **`c1-acceptance.md`:** every bullet of the spec's §14 mapped to its tests (file and test name), in the F1/F2 format; the inbound-sync bullet points at `calendar-pull.test.ts`; the real-calendar bullets point at Task 29's runbook.

**Carries and rulings:**
- **Ruling 9:** calendar e2e covers outbound sync and UI states only; inbound is mapped to `calendar-pull.test.ts` in the acceptance map.

**Verify notes:**
- locally typecheck, lint, `npx playwright test --list -c apps/web/playwright.config.ts`; CI E2E job (both projects) via `ops/bin/ci-check` with `CI_JOBS="Platform E2E"`.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint` plus focused pure tests; prove the rest with `ops/bin/ci-check`.
- Commit: `test(e2e): pipeline, records, quotes and calendar; C1 acceptance map`

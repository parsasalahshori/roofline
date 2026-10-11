# F2 acceptance checklist (spec section 4.8)

Run on branch `f2-t18`, 2026-10-11:

```
npm run lint && npm run typecheck && npx vitest run
npm run e2e -- --project desktop --project phone
```

- CI (`.github/workflows/ci.yml`) runs both: the unit suites in its test jobs and the Playwright suite in the `E2E` job (one stack build, `desktop` and `phone` projects).
- Unit tests live under `apps/web/test/`, `packages/ui/test/` and `packages/shared/test/`. End-to-end specs live under `apps/web/e2e/` and run on CI only (no Docker locally).

## Shell
- **Map home renders with seeded customer and job pins**
  - `apps/web/e2e/shell.spec.ts` — `map home shows the seeded pins`
- **Dock shows six labeled apps**
  - `apps/web/e2e/shell.spec.ts` — `dock has six labeled apps that each open one window with its own URL`
  - `apps/web/test/shell.test.tsx` — `shows six labeled dock apps`
- **Pill shows the live draft count**
  - `apps/web/e2e/shell.spec.ts` — `pill shows the live draft count`
- **Opening each app opens one centered window with its own URL**
  - `apps/web/e2e/shell.spec.ts` — `dock has six labeled apps that each open one window with its own URL`
  - `apps/web/test/shell.test.tsx` — `opens each app in one centered window with its own URL`
- **Esc and ✕ go to `/`**
  - `apps/web/e2e/shell.spec.ts` — `Esc and ✕ go home, Back goes to the previous window`
  - `apps/web/test/shell.test.tsx` — `Esc and ✕ go to the map`
- **Back goes to the previous entry**
  - `apps/web/e2e/shell.spec.ts` — `Esc and ✕ go home, Back goes to the previous window`
- **Deep-linking `/approvals/:id` opens the review directly**
  - `apps/web/e2e/shell.spec.ts` — `deep link opens the review directly` (review title, plan title, Approve button, no Today over it)
  - `apps/web/test/shell.test.tsx` — `deep-links straight to a window`
- **Focus trap**
  - `apps/web/e2e/shell.spec.ts` — `focus stays inside the window`

## Today window (once per day per user)
- **Opens once per day, again the next day**
  - `apps/web/e2e/today.spec.ts` — `opens once per day, again the next day`
  - `apps/web/e2e/today.spec.ts` — `auto-open on arrival at the map home, gone after Esc and reload`
  - `apps/web/e2e/today.spec.ts` — `a deep link does not open Today`
  - `apps/web/test/today.test.tsx` — `opens Today once when the server says to show it`; `asks once even when the page renders twice`; `never asks from a deep link`; `does not hijack a page the person opened before the answer arrives`
- **The window itself**
  - `apps/web/test/today.test.tsx` — `greets by first name in the company time zone`; `lists the top 3 drafts`; `says when nothing needs an OK`

## R2 review
- **With a seeded 3-step demo task (one spend step) as the only draft, the click-count test passes (2 clicks)**
  - `apps/web/e2e/approvals.spec.ts` — `one draft: pill to approved in 2 clicks`
  - `apps/web/e2e/approvals.spec.ts` — `from the Storm window: 2 clicks`
- **Turning a step off excludes it**
  - `apps/web/e2e/approvals.spec.ts` — `turning a step off excludes it`
  - `apps/web/test/review.test.tsx` — `turning a step off leaves it out`
- **An office user without delegation approves the other two; the spend step shows "Waiting for owner"**
  - `apps/web/e2e/approvals.spec.ts` — `office approves two, the ad waits for the owner`
  - `apps/web/test/review.test.tsx` — `an office user approves what they can, and the spend waits for the owner`
- **Results then appear live**
  - `apps/web/e2e/approvals.spec.ts` — `one draft: pill to approved in 2 clicks` (three rows reach `Done` without a reload)
  - `apps/web/test/review.test.tsx` — `shows the results of a finished plan`

## Phone (375×812)
- **Bottom tabs work** (My day, Map, Jobs, Calendar, More; no dock)
  - `apps/web/e2e/phone.spec.ts` — `bottom tabs work`
  - `apps/web/test/phone.test.tsx` — `shows five bottom tabs and no dock on a phone`; `marks the current tab`; `More opens a sheet with five links`; `choosing a More link closes the sheet and navigates`
- **No horizontal scroll**
  - `apps/web/e2e/phone.spec.ts` — `no horizontal scroll`; `long text does not widen the page`
  - `apps/web/test/phone.test.tsx` — `windows are pages on a phone`
- **The Approve button stays pinned**
  - `apps/web/e2e/phone.spec.ts` — `Approve stays pinned`

## UI tests
- **No CSS `font-size` below 12px (stylelint rule)**
  - `packages/ui/test/min-font-size.test.ts` — `roofline/min-font-size` (all cases)
- **Banned-word test passes**
  - `apps/web/test/copy-rules.test.ts` — `uses no technical words`; `uses no enum tokens`; `names vendors only where connecting accounts or paying`; `finds strings in every copy file`; `reads every kind of string and skips code`
- **Axe accessibility scan has no serious or critical violations on the shell, the approvals window and the review screen**
  - `apps/web/e2e/a11y.spec.ts` — `map home has no serious accessibility violations`
  - `apps/web/e2e/a11y.spec.ts` — `approvals list has no serious accessibility violations`
  - `apps/web/e2e/a11y.spec.ts` — `approval review has no serious accessibility violations`

## CI status
- Green on `f2-t18` at efa39ff: CI run 38183617238, Platform job (every unit and database suite) and E2E job (desktop and phone projects: shell, today, approvals, phone, a11y specs).
- Re-confirmed on `f2-shell` after the merge (see the F2 ledger).

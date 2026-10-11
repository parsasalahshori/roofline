## Global Constraints

**Code**
- **Language and modules:** Node ≥ 22.13, TypeScript strict, ESM. Relative imports carry explicit `.ts`/`.tsx` extensions, as everywhere in this repo.
- **Web import boundary:** `apps/web/src` and `packages/ui/src` import only `@roofline/ui`, `@roofline/shared` and npm packages. They never import `@roofline/db`, `@roofline/send-gate` or `@roofline/api`. `apps/web/e2e` may import them.
- **Styling:** CSS Modules plus the S1 tokens. No Tailwind and no third-party component library.
- **Component state:** components expose state through `data-*` attributes (for example `data-variant`, `data-state`). Tests assert attributes and roles, never generated class names.

**S1 tokens (CSS variables in `packages/ui/src/tokens.css`, verbatim from spec §4.5)**

| Token | Value |
|---|---|
| `--bg` | `#efe9dc` |
| `--surface` | `#fffdf8` |
| `--surface-2` | `#f6f1e6` |
| `--text` | `#2b2620` |
| `--accent` | `#f5b324` |
| `--accent-ink` | `#2b2620` |
| `--success` | `#2f9e44` |
| `--danger` | `#e03131` |
| `--line` | `#eee5cf` |
| `--radius-card` | `12px` |
| `--radius-window` | `14px` |
| `--shadow-window` | `0 12px 30px rgba(60,40,0,.15)` |

- **`--text-muted`:** `rgba(43, 38, 32, 0.72)`. **Ruling:** the spec says "60% of `--text`", but 60% gives 4.0:1 on `--surface`, which fails the spec's own WCAG AA rule. 72% passes on `--bg`, `--surface` and `--surface-2`.
- **Fonts:**
  - `--font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`
  - `--font-size-min: 12px`, `--font-size-body: 14px`, `--font-size-stat: 24px`
  - Stat numbers are 20–28px with `font-variant-numeric: tabular-nums`.
- **Hail scale (yellow → magenta):** `--hail-1: #ffe066`, `--hail-2: #ffb347`, `--hail-3: #ff7a45`, `--hail-4: #f0508c`, `--hail-5: #c026d3`. Used only for hail.
- **Map pins:**
  - `--pin-customer: #7048e8` (customer pins are purple)
  - `--stage-lead: #1971c2`, `--stage-inspection: #0b7285`, `--stage-proposal: #e67700`, `--stage-won: #2f9e44`
- **Green text:** `--success` is never used as a text colour or under white text (3.4:1). Use it for dots, icons and bars.

**Type and accessibility**
- **Minimum font size 12px anywhere.** Body text is 14px. A stylelint rule enforces this (Task 1).
- **Contrast and keyboard:** WCAG AA text contrast; every interactive element reachable by keyboard; visible focus ring (`outline: 2px solid var(--text); outline-offset: 2px` on `:focus-visible`).
- **Touch targets:** at least 40px on phone.

**Windows and layout**
- **Window size:** about 90% of the viewport, centered, at most 1280×860, with the map visible around the edges.
- **Window anatomy:** `role="dialog"` with `aria-labelledby` its title; keyboard focus trapped inside; focus returned to the opener on close.
- **Closing:** ✕ and Esc go to `/`.
- **Phone:** below 768px (`max-width: 767.98px`). Routes render full-screen and a bottom tab bar replaces the dock: My day · Map · Jobs · Calendar · More.

**Copy rules (spec §4.7)**
- **One source:** every UI string lives in `apps/web/src/copy/*.ts`. No literal text in JSX in `apps/web/src` or `packages/ui/src`; `packages/ui` takes all text as props.
- **Banned whole words (case-sensitive) in copy:** `JSON`, `API`, `sandbox`, `env`, `webhook`, `null`, `undefined`, and every snake_case value of an `as const` array exported by `@roofline/shared`.
- **Vendor names** (`EagleView`, `Twilio`, `Google`, `Meta`, `Facebook`, `Stripe`, `Outlook`, `Microsoft`, `MapTiler`) appear only in `copy/connections.ts`, `copy/setup.ts`, `copy/auth.ts`, `copy/billing.ts` and `copy/legal.ts`.
- **Status labels come from one map** in `copy/status.ts`. For example `draft` → "Waiting for your OK", `needs_attention` → "Needs attention", and `partly_done` → "Mostly done — 3 couldn't send".
- **No raw `<button>` in `apps/web/src`.** Use `Button` or `IconButton` from `@roofline/ui`. Enforced by lint (Task 2).

**Errors**
- **API errors:** show the API's plain-English `error`, next to its `field` when there is one, otherwise in a toast. No codes or stack traces.
- **Network failure:** "We couldn't reach Roofline. Check your connection and try again."
- **409 stale view:** show the API's message ("This changed while you were looking. Here's the latest.") and replace the view with `latest`.

**Ports and environment**
- **Ports:** API 4400, Vite dev 4401, end-to-end stack 4410.
- **Development origin:** in development `APP_ORIGIN=http://127.0.0.1:4401`, the Vite origin the browser sends.
- **Map key:** only through the build-time `VITE_MAPTILER_KEY`. It is never committed.

**Tests**
- **No live provider calls:** weather goes through an injected `WeatherSource`, so tests use a fake.
- **No map tiles in tests or CI:** with no `VITE_MAPTILER_KEY` and no `VITE_MAP_TILES=osm`, the map uses a blank style that makes no network requests.

**Server additions**
- **Tenant scope:** every new API read runs inside `withTenant` and applies the F1 rep-scope helpers (`jobScope`, `customerScope`, `propertyScope` in `packages/db/src/repos/scope.ts`).
- **The system pool:** only `apps/api/src/auth/**` and `apps/api/src/scripts/**` may use `@roofline/db/system`. This is the existing ESLint boundary.

## Review Focus

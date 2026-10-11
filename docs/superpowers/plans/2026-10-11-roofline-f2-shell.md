# Roofline F2 — Shell and Design Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the web app on top of the finished F1 API: the A2 shell (map desktop, labeled dock, one centered window per URL), the S1 design kit, the R2 review screen with live results, the Today window, Settings Company/Team, and the phone layout. Add the four small API endpoints the shell needs and seed demo data so it looks real.

**Architecture:**
- **New workspaces:** `packages/ui` (S1 tokens and string-free React components, CSS Modules) and `apps/web` (Vite + React 19 SPA).
- **Web stack:** React Router data router, TanStack Query for server state, and all UI text in `apps/web/src/copy/*.ts`.
- **Map:** one MapLibre map is mounted at the root and never unmounts. Every route renders inside one `<Window>` over it.
- **Serving:** in production the API serves the built SPA with a CSP that allows the map. In development Vite proxies `/api` to the API.
- **End-to-end runs:** a self-contained stack script starts PostGIS in Testcontainers, the API with the built SPA, and the worker.
- **Not in F2:**
  - Self-serve sign-up and the "Sign in with Google" button arrive with F3 §5.1. Local development signs in with the `seed:dev` accounts (Task 9).
  - Recipient "see all", "See map" and "Preview" links arrive with the agents that own that data (Storm Scout, Estimator). F2's review rows offer Edit only.

**Tech Stack:**
- React 19, React Router 7 (`createBrowserRouter` from `react-router`), @tanstack/react-query 5, maplibre-gl 5
- Vite (the newest major that vitest 5's peer range allows: 6, 7 or 8) with @vitejs/plugin-react
- Vitest 5 (jsdom) with @testing-library/react, @testing-library/user-event and @testing-library/jest-dom
- Playwright with @axe-core/playwright
- stylelint 16, with a local plugin
- eslint-plugin-react-hooks

**Spec:**
- `docs/superpowers/specs/2026-10-10-roofline-foundation-design.md` §4 (F2) and §6–7
- UX in `docs/superpowers/specs/2026-10-10-roofline-saas-design.md` §5
- The API it calls is F1's, on branch `f1-platform-core`. This plan is built on branch `f2-shell`, stacked on it.

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

These inputs and conditions are implied by the spec but are easy to miss. Each one has its test in the owning task.

1. **Session ends mid-use.** Any 401 sends the person to `/sign-in?next=<path>` and back after signing in. `next` accepts only same-site paths: a value such as `//evil.example` or `https://evil.example` falls back to `/`. (Task 10)
2. **Two people review the same plan.** A 409 replaces the view with `latest` and shows the message. A double-click on Approve sends one request. (Task 14)
3. **A company with no service area and no located addresses.**
   - The map starts at the US view with no error.
   - Pins are empty.
   - Weather is hidden, never an error, and also hidden when the weather service fails or the location is outside the US. (Tasks 7, 8, 11, 12)
4. **Long text at 375px.** A 60-character name, a 400-character message or a long address must not cause horizontal page scroll. Text truncates with an ellipsis in cards and lists and wraps in message bubbles. (Tasks 5, 17)
5. **Search input that breaks queries.** `%`, `_`, quotes, emoji and a 150-character query return 200 with results or empty lists, never a 500. A query of fewer than 2 characters returns empty lists. ⌘K and Ctrl+K open search even while focus is in a text field. (Tasks 7, 12)

---

## File structure

```
packages/ui/                      @roofline/ui — tokens + string-free components
  package.json  tsconfig.json  vitest.config.ts
  stylelint/min-font-size.js      local stylelint plugin (Task 1)
  src/tokens.css  src/base.css  src/tokens.ts  src/index.ts  src/css-modules.d.ts
  src/link.tsx                    UiLinkProvider / UiLink (router-agnostic links)
  src/focus-trap.ts               useFocusTrap
  src/components/<Name>/<Name>.tsx + <Name>.module.css   (one folder per component)
  test/*.test.ts(x)
apps/web/                         @roofline/web — the SPA
  package.json  index.html  vite.config.ts  vitest.config.ts  playwright.config.ts  tsconfig.json  .env.development
  src/main.tsx  src/vite-env.d.ts
  src/app/router.tsx  src/app/providers.tsx  src/app/RequireSession.tsx
  src/api/client.ts  src/api/types.ts  src/api/hooks.ts  src/api/keys.ts
  src/copy/*.ts                   every UI string
  src/shell/Shell.tsx  src/shell/AppWindow.tsx  src/shell/apps.ts  src/shell/useIsPhone.ts
  src/shell/map/MapView.tsx  src/shell/map/mapStyle.ts  src/shell/map/pins.ts  src/shell/map/PinCard.tsx
  src/shell/topbar/{ShellTopBar,OkPill,AgentsWorking,WeatherChip,SearchDialog,UserMenu}.tsx
  src/shell/phone/{BottomTabs,MoreSheet}.tsx
  src/features/auth/{SignIn,ResetPassword,VerifyEmail,AcceptInvite,safeNext}.ts(x)
  src/features/approvals/{ApprovalsList,Review,EditStepSheet,NotNowSheet,toReviewStep,editable}.ts(x)
  src/features/today/Today.tsx
  src/features/storm/StormWindow.tsx
  src/features/settings/{Settings,CompanyTab,TeamTab,LaterTab}.tsx
  src/features/coming-soon/ComingSoon.tsx
  test/**/*.test.ts(x)            Vitest (jsdom)
  e2e/stack.ts  e2e/fixtures.ts  e2e/*.spec.ts   Playwright
apps/api/ (modified)
  src/web.ts                      serveWeb + CSP (Task 6)
  src/auth/me.ts                  /api/me router (Task 6)
  src/routes/search.ts  src/routes/map.ts  src/routes/weather.ts
  src/weather/{source,nws,cache}.ts
  src/scripts/showcase.ts  src/scripts/seed-dev.ts
packages/db/ (modified)
  src/repos/search.ts (extend)  src/repos/map.ts  src/system/me.ts  src/testing/database.ts
```

---

### Task 1: Design kit package, tokens and the 12px font rule

**Files:**
- Create: `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/vitest.config.ts`, `packages/ui/test/setup.ts`
- Create: `packages/ui/src/tokens.css`, `packages/ui/src/base.css`, `packages/ui/src/tokens.ts`, `packages/ui/src/index.ts`, `packages/ui/src/css-modules.d.ts`
- Create: `packages/ui/stylelint/min-font-size.js`, `stylelint.config.js` (repo root)
- Modify: root `package.json` (add `lint:css`), root `tsconfig.json` (reference `packages/ui`), `.github/workflows/ci.yml` (run `npm run lint:css`)
- Test: `packages/ui/test/tokens.test.ts`, `packages/ui/test/min-font-size.test.ts`

**Interfaces:**
- Produces:
  - `@roofline/ui` (exports `./src/index.ts`) and `@roofline/ui/tokens.css` and `@roofline/ui/base.css`
  - `tokens: Readonly<Record<TokenName, string>>`, a TS mirror of every custom property in `tokens.css`, keyed by name without `--`, e.g. `tokens['stage-lead']`. The map needs literal colours.
  - stylelint rule `roofline/min-font-size`
- Package setup:
  - `package.json`: `"type": "module"`, peer deps `react@^19` and `react-dom@^19`
  - `tsconfig.json`: extends `../../tsconfig.base.json` with `"jsx": "react-jsx"`, `"lib": ["ES2023","DOM","DOM.Iterable"]`, `"types": ["node"]`; mirror `packages/shared/tsconfig.json` for `composite`/`include`
  - `vitest.config.ts`: `defineProject` with `environment: 'jsdom'`, `setupFiles: ['test/setup.ts']` (imports `@testing-library/jest-dom/vitest`), and `css: { modules: { classNameStrategy: 'non-scoped' } }`

- [ ] **Step 1: Write the failing tests**

`tokens.test.ts`: read `src/tokens.css` as text and parse every `--name: value;` inside `:root`.
- `it('has every S1 token with its exact value')`: for each row of the Global Constraints token table, plus `--text-muted`, the fonts, the hail scale and the pins, `expect(css.get(name)).toBe(value)`.
- `it('tokens.ts mirrors tokens.css')`: `expect(Object.keys(tokens).length).toBe(css.size)`, and every `tokens[k]` equals `css.get('--' + k)`.

`min-font-size.test.ts`: use `stylelint.lint({ code, config: { plugins: [plugin], rules: { 'roofline/min-font-size': true } } })`.
```ts
const bad = ['a{font-size:11px}', 'a{font-size:0.7rem}', 'a{font:600 10px/1.2 serif}',
             'a{font-size:80%}', 'a{font-size:smaller}', 'a{font-size:0.8em}', 'a{font-size:calc(1px + 1vw)}'];
const good = ['a{font-size:12px}', 'a{font-size:0.75rem}', 'a{font-size:var(--font-size-body)}',
              'a{font:600 14px/1.4 var(--font)}', 'a{font-size:28px}'];
// each bad → results[0].warnings.length === 1 with text containing 'at least 12px'
//   (or, for %/em/keywords/calc: 'Use px, rem or a var(--font-size-*) token')
// each good → 0 warnings
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project @roofline/ui`
Expected: FAIL (files missing).

- [ ] **Step 3: Implement**
- **Tokens:** `tokens.css` declares the `:root` custom properties from Global Constraints. `tokens.ts` holds the same values.
- **`base.css`:**
  - box-sizing border-box
  - `body { margin:0; background:var(--bg); color:var(--text); font: 400 var(--font-size-body)/1.45 var(--font) }`
  - the focus-visible ring
  - `.visually-hidden` (the standard clip pattern)
  - `@media (prefers-reduced-motion: reduce)` turns transitions off
- **Plugin:** `min-font-size.js` uses `stylelint.createPlugin` and `postcss-value-parser`.
  - Check `font-size`, and the size token of the `font` shorthand.
  - px must be ≥ 12. rem is converted ×16.
  - `var(--font-size-*)` passes.
  - Anything else (%, em, keywords, calc) is reported.
- **Config:** `stylelint.config.js` loads the plugin and sets `files: ['packages/ui/src/**/*.css', 'apps/web/src/**/*.css']`.
- **Root script:** `"lint:css": "stylelint \"packages/ui/src/**/*.css\" \"apps/web/src/**/*.css\" --allow-empty-input"`

- [ ] **Step 4: Run tests, lint and typecheck**

Run: `npx vitest run --project @roofline/ui && npm run lint:css && npm run typecheck`
Expected: PASS, no stylelint warnings.

- [ ] **Step 5: Commit** — `feat(ui): S1 tokens, base styles and the 12px font rule`

---

### Task 2: Web app scaffold, lint boundaries and copy rules

**Files:**
- Create: `apps/web/package.json` (`@roofline/web`), `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/vitest.config.ts`, `apps/web/tsconfig.json`, `apps/web/.env.development`, `apps/web/src/main.tsx`, `apps/web/src/vite-env.d.ts`, `apps/web/test/setup.ts`
- Create: `apps/web/src/copy/common.ts`, `status.ts`, `auth.ts`, `connections.ts`, `setup.ts`, `billing.ts`, `legal.ts`
- Modify: `eslint.config.js`, root `package.json` (scripts `dev:api`, `dev:web`, `build:web`), root `tsconfig.json` (reference `apps/web`), `.gitignore` (`apps/web/dist`, `apps/web/e2e/.stack.json`, `apps/web/test-results`, `apps/web/playwright-report`)
- Test: `apps/web/test/copy-rules.test.ts`, `apps/web/test/status-labels.test.ts`, `apps/web/test/lint-rules.test.ts`

**Interfaces:**
- Produces:
  - `copy/status.ts`:
    - `TASK_STATUS_LABEL: Record<Exclude<TaskStatus,'partly_done'>, string>`
    - `STEP_STATUS_LABEL: Record<StepStatus, string>`
    - `AGENT_LABEL: Record<Agent, string>`
    - `taskStatusLabel(task: { status: TaskStatus; steps: { status: StepStatus; result: StepResult | null }[] }): string`
    - `stepStatusLabel(status: StepStatus): string`
  - `copy/common.ts`: `common = { appName: 'Roofline', networkError: "We couldn't reach Roofline. Check your connection and try again.", close: 'Close', ... }`
- Labels:
  - `TASK_STATUS_LABEL`: draft "Waiting for your OK"; awaiting_owner "Waiting for owner"; approved "Approved"; declined "Not now"; expired "Expired"; running "Working on it"; done "Done"; needs_attention "Needs attention".
  - `taskStatusLabel` for `partly_done`: N = the sum of `result.failed` and `result.blocked` (numbers only) across steps; if N is 0, the count of steps in `failed`/`needs_attention`. N > 0 gives `Mostly done — ${N} couldn't send`; N = 0 gives `Mostly done`.
  - `STEP_STATUS_LABEL`: pending "Ready"; awaiting_owner "Waiting for owner"; skipped "Turned off"; queued "Starting soon"; running "Working on it"; done "Done"; failed "Didn't finish — we'll try again"; needs_attention "Needs attention".
  - `AGENT_LABEL`: storm_scout "Storm Scout"; estimator "Estimator"; front_desk "Front Desk"; claims "Claims"; scheduler "Scheduler"; follow_up "Follow-up"; system "Roofline".
- Vite config: React plugin; `server: { host: '127.0.0.1', port: 4401, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4400', '/hooks': 'http://127.0.0.1:4400', '/health': 'http://127.0.0.1:4400' } }`; `build.outDir: 'dist'`.
- `vitest.config.ts`: jsdom, `include: ['test/**/*.test.{ts,tsx}']`. It must never pick up `e2e/`.
- `.env.development`: `VITE_MAP_TILES=osm`.
- Root scripts:
  - `dev:api`: `npm run dev -w @roofline/api`
  - `dev:web`: `npm run dev -w @roofline/web`
  - `build:web`: `npm run build -w @roofline/web`
- `main.tsx`: imports `@roofline/ui/base.css` and `@roofline/ui/tokens.css` and renders `<StrictMode>` with a placeholder `<p>{common.appName}</p>`. Task 10 replaces it with the router.

- [ ] **Step 1: Write the failing tests**

`copy-rules.test.ts`:
- Glob `src/copy/*.ts` with `fs.readdirSync` and parse each file with the `typescript` compiler API. Collect the text of every `StringLiteral`, `NoSubstitutionTemplateLiteral`, `TemplateHead`, `TemplateMiddle` and `TemplateTail`.
- Matching is whole-word: `new RegExp('(?<![A-Za-z0-9_])' + escape(word) + '(?![A-Za-z0-9_])')`, case-sensitive.
- Tests:
  - `it('uses no technical words')` with the seven words.
  - `it('uses no enum tokens')`. The banned set is every string containing `_` in every `as const` array exported by `@roofline/shared`: iterate `Object.values(await import('@roofline/shared'))`, keep the arrays of strings, and include `STEP_TYPES`.
  - `it('names vendors only where connecting accounts or paying')` with the 9 names and the 5 allowed files.
  - `it('finds strings in every copy file')`: guards against a parser that silently finds nothing; each file yields at least 1 string.

`status-labels.test.ts`:
```ts
for (const s of TASK_STATUSES.filter((s) => s !== 'partly_done')) expect(TASK_STATUS_LABEL[s]).toMatch(/\S/);
for (const s of STEP_STATUSES) expect(STEP_STATUS_LABEL[s]).toMatch(/\S/);
for (const a of AGENTS) expect(AGENT_LABEL[a]).toMatch(/\S/);
expect(taskStatusLabel({ status: 'draft', steps: [] })).toBe('Waiting for your OK');
expect(taskStatusLabel({ status: 'partly_done', steps: [{ status: 'done', result: { sent: 28, failed: 2, blocked: 1 } }] }))
  .toBe("Mostly done — 3 couldn't send");
expect(taskStatusLabel({ status: 'partly_done', steps: [{ status: 'needs_attention', result: null }, { status: 'done', result: null }] }))
  .toBe("Mostly done — 1 couldn't send");
```

`lint-rules.test.ts`: `new ESLint({ cwd: repoRoot })` and `lintText(code, { filePath })`.
- `<button className="x">Go</button>` at `apps/web/src/features/x/Fake.tsx` gives a message containing `Button or IconButton from @roofline/ui`.
- `<p>Hello there</p>` at the same path gives a message containing `apps/web/src/copy`.
- `<input placeholder="Search" />` gives the same copy message.
- `<p>{copy.x}</p>` gives no message.
- `<button>` at `packages/ui/src/components/Button/Button.tsx` gives no raw-button message (the kit itself may use it).
- `import { withTenant } from '@roofline/db'` at `apps/web/src/x.ts` gives a boundary message.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project @roofline/web`
Expected: FAIL.

- [ ] **Step 3: Implement the copy files, status map and ESLint rules**

ESLint (`eslint.config.js`):
- **File patterns:** widen to `{apps,packages}/**/*.{ts,tsx}`, and add `eslint-plugin-react-hooks` (recommended) for `**/*.tsx`.
- **Web and kit boundary:** a `no-restricted-imports` block for `apps/web/src/**` and `packages/ui/src/**` that forbids `@roofline/db*`, `@roofline/send-gate*` and `@roofline/api*`. Merge it with the existing db/system patterns; flat config replaces a rule's options per file match.
- **No literal text** (`no-restricted-syntax`, for `apps/web/src/**/*.tsx` and `packages/ui/src/**/*.tsx`):
  - `JSXText[value=/[A-Za-z]/]`
  - `JSXAttribute[name.name=/^(aria-label|title|placeholder|alt|label)$/] > Literal[value=/[A-Za-z]/]`
  - both with the message `Put UI text in apps/web/src/copy and pass it in.`
- **No raw buttons:** for `apps/web/src/**/*.tsx` only, `JSXOpeningElement[name.name="button"]` with the message `Use Button or IconButton from @roofline/ui.`
- **Ignores:** add `apps/web/dist/**` and `**/playwright-report/**`.

Seed each copy file with the strings later tasks need: `auth.ts` gets the sign-in strings (Task 10); `connections.ts`, `setup.ts`, `billing.ts` and `legal.ts` get the Settings "coming with setup" strings (Task 16) and the map attribution (Task 11).

- [ ] **Step 4: Run tests, lint and typecheck**

Run: `npx vitest run --project @roofline/web && npm run lint && npm run typecheck && npm run build:web`
Expected: PASS; `apps/web/dist/index.html` exists.

- [ ] **Step 5: Commit** — `feat(web): app scaffold, copy rules, status labels and lint boundaries`

---

### Task 3: Design kit primitives

**Files:**
- Create: `packages/ui/src/components/{Button,IconButton,Card,StatCard,Toggle,Field,Select,Badge,Pill,Avatar,Skeleton,EmptyState}/*`, `packages/ui/src/link.tsx`
- Modify: `packages/ui/src/index.ts`
- Test: `packages/ui/test/primitives.test.tsx`

**Interfaces:**
- **Links:** `UiLinkProvider({ component, children })` and `UiLink(props: AnchorHTMLAttributes & { href: string })`. `UiLink` renders the provided component, defaulting to `<a>`. The web app provides a React Router `Link` adapter.
- `Button(props: ButtonHTMLAttributes & { variant?: 'primary'|'ghost'|'danger'; size?: 'md'|'lg'; busy?: boolean; href?: string })`
  - With `href` it renders `UiLink` styled as a button.
  - `busy` sets `aria-busy="true"` and `disabled`.
  - It sets `data-variant`.
  - The default `type` is `"button"`.
  - `min-height: 40px`.
- `IconButton(props: ButtonHTMLAttributes & { label: string; icon: ReactNode; href?: string })`: `aria-label={label}`, 40×40 minimum.
- `Card({ children, as?: 'div'|'section'|'li', padded?: boolean })`
- `StatCard({ label: string; value: ReactNode; hint?: string })`: the value is 24px with tabular numbers.
- `Toggle({ checked; onChange(next: boolean): void; label: string; labelHidden?: boolean; disabled?: boolean })`: `role="switch"` with `aria-checked`, and `data-state="on"|"off"`.
- `Field(props: InputHTMLAttributes & { label: string; help?: string; error?: string; multiline?: boolean; rows?: number })`
  - The label is tied to the input.
  - `aria-describedby` lists the help and error ids.
  - `aria-invalid` is set when there is an error, and the error has `role="alert"`.
- `Select({ label; value; onChange(v: string): void; options: { value: string; label: string }[]; help?; error?; disabled? })`
- `Badge({ count: number; label: string })`: renders nothing at 0. It shows `99+` above 99; `label` is the accessible text.
- `Pill({ children; href?: string; onClick?; tone?: 'accent'|'neutral' })`: a link with `href`, otherwise a button.
- `Avatar({ name: string; size?: 24|32|40 })`: initials of the first and last word, `aria-hidden`.
- `Skeleton({ width?: string; height?: string; lines?: number })`: `aria-hidden`.
- `EmptyState({ title: string; body?: string; action?: ReactNode })`

- [ ] **Step 1: Write the failing tests** (`primitives.test.tsx`, Testing Library):
  - `Button`: the default `type` is `button`; `busy` → `toBeDisabled()` and `aria-busy`; `href` renders an `<a>` through a provided link component, asserted by a fake provider recording its props.
  - `Toggle`: `getByRole('switch', { name: 'Text 31 customers' })`; a click calls `onChange(false)` when checked; `disabled` blocks the click.
  - `Field`: `getByLabelText('Email')` has `aria-describedby` containing the help and error ids; the error has `role="alert"`; `aria-invalid="true"`.
  - `Badge`: `count={0}` renders nothing; `count={120}` shows `99+`; the accessible name is the label.
  - `IconButton`: `getByRole('button', { name: 'Close' })`.
  - `Avatar`: `name="Dana Park"` → `DP`; `name="Cher"` → `C`.
  - `Select`: changing it calls `onChange('office')`.
- [ ] **Step 2: Run them and see them fail** — `npx vitest run --project @roofline/ui`.
- [ ] **Step 3: Implement** each component with a CSS Module that uses only tokens. The primary button uses `--accent` with `--accent-ink` text; danger uses `--danger` with white text; ghost is transparent with `--line` hover.
- [ ] **Step 4: Run tests and the lints** — `npx vitest run --project @roofline/ui && npm run lint && npm run lint:css && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(ui): primitives (button, toggle, field, select, badge, pill, cards)`

---

### Task 4: Design kit layout: Window, Sheet, Dock, TopBar, Toast, focus trap

**Files:**
- Create: `packages/ui/src/focus-trap.ts`, `packages/ui/src/components/{Window,Sheet,Dock,TopBar,Toast}/*`
- Modify: `packages/ui/src/index.ts`
- Test: `packages/ui/test/layout.test.tsx`

**Interfaces:**
- `useFocusTrap(ref: RefObject<HTMLElement | null>, opts: { active: boolean; onEscape?: () => void; initialFocus?: RefObject<HTMLElement | null> }): void`
  - While active: Tab and Shift+Tab cycle through the tabbable elements inside `ref`, and Esc calls `onEscape`.
  - On activation it remembers `document.activeElement` and focuses `initialFocus` (else the container, which has `tabIndex={-1}`).
  - On deactivation or unmount it restores focus to the remembered element when that element is still connected; otherwise it leaves focus alone.
  - **Mouse clicks outside are not blocked.** The dock stays clickable while a window is open.
- `Window({ title: string; description?: string; stats?: ReactNode; onClose(): void; closeLabel: string; children; variant?: 'floating'|'page'; footer?: ReactNode })`
  - `role="dialog"`, `aria-modal="true"`, `aria-labelledby` the `<h1>` title, `aria-describedby` the description.
  - It has a ✕ `IconButton(closeLabel)` and uses `useFocusTrap` with `onEscape: onClose`.
  - `floating`: `width: min(90vw, 1280px); height: min(90vh, 860px)`, centered, `--radius-window`, `--shadow-window`, with the body scrolling inside.
  - `page`: full-screen for phone.
  - `footer` renders in a sticky bottom area.
  - It sets `data-variant`.
- `Sheet({ open: boolean; title: string; onClose(): void; closeLabel: string; children; footer?: ReactNode })`: a bottom sheet on phone and a right-side panel on desktop. Same dialog semantics and trap. Renders nothing when closed.
- `DockItem = { key: string; label: string; href: string; icon: ReactNode; badge?: { count: number; label: string }; comingSoon?: string; current?: boolean }`
- `Dock({ label: string; items: DockItem[] })`
  - A `<nav aria-label>` holding a list of `UiLink`s.
  - **The label is always visible** under its icon.
  - `aria-current="page"` when `current`.
  - A coming-soon item has `data-state="soon"`: it is muted, still a clickable link, and has `title={comingSoon}` plus a visually hidden suffix.
- `TopBar({ start: ReactNode; middle?: ReactNode; end?: ReactNode })`: a `<header>` with three slots.
- `ToastProvider({ children })` and `useToast(): { show(message: string, tone?: 'info'|'success'|'error'): void }`
  - Errors render in `role="alert"`; the others in a `role="status"` live region.
  - Toasts auto-dismiss after 6 s, and the same message is not stacked twice.

- [ ] **Step 1: Write the failing tests** (`layout.test.tsx`):
  - `it('traps Tab inside the window and closes on Esc')`: render a page button ("opener"), click it to mount `<Window>` holding two buttons. `user.tab()` cycles first → close → second → first; never the opener. `user.keyboard('{Escape}')` calls `onClose`.
  - `it('returns focus to the opener on unmount')`: focus the opener, mount, then unmount → `document.activeElement === opener`.
  - `it('labels the dialog by its title')`: `getByRole('dialog', { name: 'Need your OK' })`.
  - `it('keeps dock labels visible and marks the current app')`: six items; each label `toBeVisible()`; the current one has `aria-current="page"`; the soon item has `data-state="soon"` and `title`.
  - `it('announces errors as alerts and others as status')`.
  - `Sheet` closed → `queryByRole('dialog')` is null.
- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run tests and the lints** (as Task 3). Expected: PASS.
- [ ] **Step 5: Commit** — `feat(ui): window, sheet, dock, top bar, toasts and focus trap`

---

### Task 5: ReviewSteps (the R2 review component)

**Files:**
- Create: `packages/ui/src/components/ReviewSteps/{ReviewSteps.tsx,ReviewSteps.module.css,summarize.ts}`
- Modify: `packages/ui/src/index.ts`
- Test: `packages/ui/test/review-steps.test.tsx`, `packages/ui/test/summarize.test.ts`

**Interfaces:**
- Consumes: `StepPreview`, `StepResult`, `StepStatus` and `ApprovalClass` types from `@roofline/shared` (type-only imports).
- Produces:
```ts
export type ReviewStep = {
  id: string; title: string; approvalClass: ApprovalClass; status: StepStatus;
  enabled: boolean; canApprove: boolean; open: boolean;      // open: still waiting for this caller's decision
  preview: StepPreview; result: StepResult | null; errorPlain: string | null;
  editable: boolean;
};
export type ApprovalSummary = { count: number; maxSpendCents: number; ownerSteps: number };
export function summarizeApproval(steps: ReviewStep[]): ApprovalSummary;
export type ReviewStepsCopy = {
  approveButton(s: ApprovalSummary): string; nothingOn: string; notNow: string;
  footerNoteSpend: string; footerNote: string; ownerApprovesSpending: string; waitingForOwner: string;
  edit: string; retry: string; switchLabel(title: string): string;
  recipients(count: number): string; sendTime(when: string): string; spend(cents: number): string;
  stepStatus(status: StepStatus): string; resultLines(result: StepResult): string[];
};
export function ReviewSteps(props: {
  mode: 'review' | 'progress'; steps: ReviewStep[]; copy: ReviewStepsCopy;
  approving?: boolean; pendingStepIds?: ReadonlySet<string>;
  onToggle(stepId: string, enabled: boolean): void; onEdit?(stepId: string): void;
  onRetry?(stepId: string): void; onApprove(): void; onNotNow(): void;
}): JSX.Element;
```
- **`summarizeApproval`** counts only `open` steps that are switched on:
  - `count`: the ones with `canApprove`
  - `ownerSteps`: the ones without
  - `maxSpendCents`: the sum of `preview.maxSpendCents ?? 0` over the counted `spend` steps
- **Rows, in order:**
  - a `Toggle` (`switchLabel(title)`), disabled when the step is not `open`, or is in `pendingStepIds`, or the caller cannot approve it
  - the bold title
  - the preview:
    - `messageSample` in a message bubble that wraps long text
    - `recipients(recipientCount)`
    - `sendTime(sendTime)`
    - `spend(maxSpendCents)`
    - each of `lines`
  - an `Edit` link-button when `editable` and `open` and `canApprove`
  - `ownerApprovesSpending` on a `spend` step without `canApprove`
  - a switched-off step has `data-state="off"` and is greyed
- **No other action links yet.** "See all", "See map" and "Preview" are not built in F2 (see Architecture).
- **Footer (`mode: 'review'`):**
  - the note: `footerNoteSpend` when any spend step exists, else `footerNote`
  - `Not now` (ghost)
  - the primary `Approve` button, labelled `approveButton(summary)`, or `nothingOn` (and disabled) when `count + ownerSteps === 0`
  - it is `busy` while `approving`
  - the footer is `position: sticky; bottom: 0` inside the scroll body, so it stays pinned on phone
- **Progress (`mode: 'progress'`):** each row shows `stepStatus(status)`, then `resultLines(result)`, then `errorPlain`.
  - A step in `awaiting_owner` shows `waitingForOwner`.
  - **Retry is keyed on status** (F1 follow-up): it appears when the status is `failed` or `needs_attention` and `canApprove`, never because `errorPlain` is set.

- [ ] **Step 1: Write the failing tests**

`summarize.test.ts`:
```ts
const owner = [msg(), internal(), spend(27000)];                      // all canApprove, open, on
expect(summarizeApproval(owner)).toEqual({ count: 3, maxSpendCents: 27000, ownerSteps: 0 });
const office = [msg(), internal(), spend(27000, { canApprove: false })];
expect(summarizeApproval(office)).toEqual({ count: 2, maxSpendCents: 0, ownerSteps: 1 });
expect(summarizeApproval([msg({ enabled: false }), internal()])).toEqual({ count: 1, maxSpendCents: 0, ownerSteps: 0 });
expect(summarizeApproval([msg({ open: false, status: 'done' })])).toEqual({ count: 0, maxSpendCents: 0, ownerSteps: 0 });
```
`review-steps.test.tsx` (with a test copy object):
- `it('labels Approve from the summary')`: the owner case renders the button named `copy.approveButton({count:3,maxSpendCents:27000,ownerSteps:0})`.
- `it('greys a switched-off step and leaves it out of the count')`: toggling calls `onToggle(id,false)`; rerendered with `enabled:false`, the row has `data-state="off"` and the button label is recomputed.
- `it('tells an office user the owner approves spending')`.
- `it('shows Retry only for failed or needs-attention steps')`: a `running` step with `errorPlain` set has no Retry; `failed` has Retry, which calls `onRetry(id)`.
- `it('disables Approve when nothing is on')`.
- `it('wraps a 400-character message')`: the bubble has `overflow-wrap: anywhere` (assert the computed style through the module class, or the inline `data-wrap` attribute the CSS keys on).
- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run tests and the lints**. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(ui): ReviewSteps, the one review screen every agent uses`

---

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

### Task 7: API: search, map pins, map area

**Files:**
- Create: `apps/api/src/routes/search.ts`, `apps/api/src/routes/map.ts`, `packages/db/src/repos/map.ts`
- Modify: `packages/db/src/repos/search.ts` (add `searchAll`), `packages/db/src/index.ts`, `apps/api/src/app.ts` (mount `/api/search`, `/api/map`)
- Test: `apps/api/test/search.test.ts`, `apps/api/test/map.test.ts`

**Interfaces:**
- Search types:
```ts
export type SearchCustomer = { id: string; displayName: string; phone: string | null };            // primary phone, E.164
export type SearchJob = { id: string; stage: JobStage; stageLabel: string; customerId: string;
                          customerName: string; propertyId: string | null; addressLine: string | null };
export type SearchAddress = { id: string; addressLine: string; city: string | null; state: string | null;
                              zip: string | null; customerId: string; customerName: string };
export async function searchAll(tx: Tx, ctx: TenantContext, q: string, limit: number):
  Promise<{ customers: SearchCustomer[]; jobs: SearchJob[]; addresses: SearchAddress[] }>;
```
- **`GET /api/search?q=`** → `{ customers, jobs, addresses }`, each at most 8.
  - `q` is trimmed. Fewer than 2 characters returns three empty lists. More than 100 characters are cut to 100. `q` missing is treated as empty.
  - **Matching:**
    - customers: as `GET /api/customers?q=` (name, or phone digits when there are 3 or more digits)
    - addresses: properties that have a customer, matching address line, city or zip
    - jobs: jobs whose customer name or address line matches
  - **Ordering:** customers by `lower(display_name)`; addresses by `lower(address_line)`; jobs by `created_at desc`.
  - **Exclusions:** archived rows are left out, and the rep scope helpers apply to all three. Use `escapeLike` for every pattern.
- Map types:
```ts
export type GeoJsonMultiPolygon = { type: 'MultiPolygon'; coordinates: number[][][][] };
export type Bbox = { west: number; south: number; east: number; north: number };
export type CustomerPin = { propertyId: string; customerId: string; lng: number; lat: number; name: string; addressLine: string };
export type JobPin = { jobId: string; customerId: string; propertyId: string; stage: JobStage; stageLabel: string;
                       lng: number; lat: number; name: string; addressLine: string };
export type PinCluster = { layer: 'customers' | 'jobs'; lng: number; lat: number; count: number };
export type PinsResult = { mode: 'points'; customers: CustomerPin[]; jobs: JobPin[] }
                       | { mode: 'clusters'; clusters: PinCluster[]; total: number };
export const SERVER_CLUSTER_ABOVE = 2000;
export async function mapPins(tx: Tx, ctx: TenantContext, bbox: Bbox, layers: ReadonlySet<'customers'|'jobs'>): Promise<PinsResult>;
export async function mapArea(tx: Tx, ctx: TenantContext): Promise<{ serviceArea: GeoJsonMultiPolygon | null; bounds: [number, number, number, number] | null }>;
```
- **`GET /api/map/pins?bbox=w,s,e,n&layers=customers,jobs`**
  - **Validation:**
    - `bbox` must be 4 finite numbers with −180 ≤ w < e ≤ 180 and −90 ≤ s < n ≤ 90. Otherwise 400 with `field: 'bbox'` and "Please give the map area as west,south,east,north."
    - `layers` defaults to both; an unknown layer is a 400 with `field: 'layers'`.
    - The antimeridian is not supported.
  - **Points:**
    - Customer pins: non-archived properties with `geom` and a non-archived customer. The customer must be visible (`customerScope`) and the property visible (`propertyScope`). The point is the property's.
    - Job pins: non-archived jobs in stages `lead`, `inspection`, `proposal` or `won`, visible (`jobScope`), whose property has `geom`.
    - Both use `ST_Intersects(geom, ST_MakeEnvelope(w,s,e,n,4326))`.
  - **Clustering:** first count both layers. When customers + jobs > `SERVER_CLUSTER_ABOVE`, return clusters instead.
    - Group per layer by `ST_SnapToGrid(geom, cell)` with `cell = (east - west) / 48`.
    - The cluster point is `ST_Centroid(ST_Collect(geom))`.
- **`GET /api/map/area`**
  - `serviceArea`: the company's `service_area` as GeoJSON (`ST_AsGeoJSON`), or null.
  - `bounds`: `ST_Extent` of the service area, else the extent of the company's visible located properties, else null.
- **Roles:** any member may call these, with rep scoping.

- [ ] **Step 1: Write the failing tests** (`crm-helpers.ts` actors; create rows through the F1 API or the repos)

`search.test.ts`:
- `it('finds customers, jobs and addresses')`: customer "Maria Lopez" with a property "1200 Pine St" and a job → `q=lop` returns her in customers, the job in jobs (customerName "Maria Lopez"), and the address in addresses. `q=pine` finds the address and the job.
- `it('caps each list at 8')`: 10 matching customers → 8.
- `it('returns empty lists for a 1-character query')`.
- `it('survives LIKE characters, quotes and emoji')`: `q` in `['%', '_', "o'neil", '"', '🏠', 'x'.repeat(150)]` → 200, and `%` does not match everything.
- `it('scopes a rep to what they may see')`: rep sees the customer of their assigned job and not another rep's.
- `it('stays inside the company')`: company B's names never appear.

`map.test.ts`:
- `it('returns customer and open-job pins inside the box')`: properties at (−95.93, 41.25) and (−90, 30). The box `-96.2,41.1,-95.8,41.4` returns only the first. A job in stage `lost` gives no job pin; a `proposal` job does, with `stageLabel: 'Proposal'`.
- `it('clusters on the server above 2,000 points')`: insert 2,001 located properties with customers in one transaction via SQL `generate_series` → `mode: 'clusters'`, the sum of counts is 2,001, and `total: 2001`.
- `it('refuses a bad box')`: `bbox=1,2,3`, `bbox=10,0,5,1` and `bbox=a,b,c,d` → 400 with `field: 'bbox'`.
- `it('scopes a rep')`.
- `it('area: service area, else address extent, else null')`:
  - With no service area and no located addresses → `{ serviceArea: null, bounds: null }`.
  - Add a located property → bounds is the point's extent.
  - Set `service_area` with SQL `ST_Multi(ST_GeomFromText('POLYGON((...))', 4326))` → `serviceArea.type === 'MultiPolygon'` and the bounds equal the polygon's extent.

- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement** (signatures above; raw `sql` from drizzle for the PostGIS parts).
- [ ] **Step 4: Run the tests, lint and typecheck**. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(api): search, map pins with server clustering, map area`

---

### Task 8: API: weather

**Files:**
- Create: `apps/api/src/weather/source.ts`, `apps/api/src/weather/nws.ts`, `apps/api/src/weather/cache.ts`, `apps/api/src/routes/weather.ts`, `packages/db/src/repos/map.ts` (add `companyLocation`), `apps/api/test/fixtures/nws-points.json`, `apps/api/test/fixtures/nws-hourly.json`
- Modify: `apps/api/src/app.ts` (`AppDeps.weather`, mount), `apps/api/src/deps.ts` (`NwsWeatherSource` / `NullWeatherSource`), `apps/api/src/config.ts` (`NWS_USER_AGENT`, `WEATHER_DISABLED`, both optional), `apps/api/test/helpers.ts` (`FakeWeatherSource` in `TestApp`), `.env.example`
- Test: `apps/api/test/weather.test.ts`, `apps/api/test/nws.test.ts`

**Interfaces:**
```ts
export type WeatherIcon = 'sun' | 'moon' | 'cloud' | 'rain' | 'storm' | 'snow' | 'fog' | 'wind';
export type CurrentWeather = { tempF: number; summary: string; icon: WeatherIcon; isDaytime: boolean; updatedAt: string };
export interface WeatherSource { current(lat: number, lng: number): Promise<CurrentWeather | null> }
export class NwsWeatherSource implements WeatherSource { constructor(opts: { userAgent: string; fetch?: typeof fetch; timeoutMs?: number }) }
export class WeatherCache { constructor(source: WeatherSource, clock: Clock, ttlMs = 30 * 60_000); get(key: string, lat: number, lng: number): Promise<CurrentWeather | null> }
export async function companyLocation(tx: Tx, ctx: TenantContext): Promise<{ lat: number; lng: number } | null>;
```
- **`NwsWeatherSource`**
  - Calls `GET https://api.weather.gov/points/{lat4},{lng4}` (4 decimals), reads `properties.forecastHourly`, GETs it, and uses `properties.periods[0]`.
  - Maps the fields: `temperature` (°F; convert when `temperatureUnit` is `C`), `shortForecast` → `summary`, `isDaytime`.
  - Picks the icon from keyword matches on `shortForecast`: thunder → storm; snow, sleet or flurr → snow; rain, shower or drizzle → rain; fog or haze → fog; wind or breez → wind; cloud or overcast → cloud; otherwise sun by day and moon by night.
  - Sends `User-Agent` and `Accept: application/geo+json`, with a 4 s timeout through `AbortSignal.timeout`.
  - **Any non-200, timeout or parse failure resolves `null`.** It never throws.
- **`WeatherCache`**
  - Caches per key for 30 minutes, including a `null` result, so an outage is not hammered.
  - Concurrent misses share one in-flight promise.
- **`companyLocation`:** `ST_PointOnSurface(service_area)`, else `ST_Centroid(ST_Collect(geom))` of the company's located, non-archived properties (rep scope does not apply; this is the company's location), else null.
- **`GET /api/weather`** → `{ weather: CurrentWeather | null }`. With no location, `weather` is null and no fetch is made. Cache key: `${companyId}:${lat.toFixed(2)},${lng.toFixed(2)}`.
- **Config:**
  - `NWS_USER_AGENT` is optional. Default: `Roofline (${PUBLIC_BASE_URL})`.
  - `WEATHER_DISABLED` is optional. `1` or `true` makes `buildDeps` use `NullWeatherSource`, which always returns null. The e2e stack sets it, so the suite never touches the network.
- **Deps:** `AppDeps.weather: WeatherSource`. `buildDeps` uses `NwsWeatherSource`; tests use `FakeWeatherSource`, which records calls and returns a set value.

- [ ] **Step 1: Write the failing tests**

`nws.test.ts` (an injected `fetch` that serves the two fixture files; no network):
- `it('reads the first hourly period')` → `{ tempF: 64, summary: 'Mostly Sunny', icon: 'sun', isDaytime: true }`. Write the fixtures with those values.
- `it('converts Celsius')`.
- `it('maps thunderstorms to storm and night clear to moon')`.
- `it('returns null on a 500, a timeout and bad JSON')`.
- `config.test.ts`: `WEATHER_DISABLED=1` makes `buildDeps(...).weather` a `NullWeatherSource`.
- `it('sends a User-Agent')`.

`weather.test.ts`:
- `it('is null without a location and makes no call')`.
- `it('uses the service area, then caches for 30 minutes')`: set the service area; two GETs give one source call. `clock.advance(31 min)`, then GET → two calls.
- `it('caches a failure too')`: the source returns null → `{weather:null}`, and a second GET makes no call.
- `it('needs a session')`.

- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run the full suite and lint**. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(api): weather for the company location (NWS, cached 30 minutes)`

---

### Task 9: Showcase data, dev seed, richer demo plan, reusable test database

**Files:**
- Create: `apps/api/src/scripts/showcase.ts`, `apps/api/src/scripts/seed-dev.ts`, `packages/db/src/testing/database.ts`
- Modify:
  - `packages/shared/src/steps.ts` (optional demo payload fields)
  - `apps/api/src/tasks/demo.ts` (`demoTask(now, companyName?)`)
  - `packages/db/src/testing/seed.ts` (extract `seedCompany`)
  - `packages/db/src/testing/global-setup.ts` (use `startTestDatabase`)
  - `packages/db/src/testing/index.ts`, `packages/db/src/repos/companies.ts` (add `setServiceArea`), `apps/api/src/index.ts` (export `seedShowcase` and `seedDemoTask`), `apps/api/package.json` (script `seed:dev`), README
- Test: `apps/api/test/showcase.test.ts`, `apps/api/test/seed-demo.test.ts` (update), `packages/shared/test/steps.test.ts` (extend)

**Interfaces:**
- **Demo step payloads** (shared):
  - `demo_message` accepts optional `sample?: string` (≤ 640 characters), `recipientCount?: int ≥ 0` and `sendTime?: string` (≤ 60). Its preview copies them into `messageSample`, `recipientCount` and `sendTime`.
  - `demo_spend` accepts optional `area?: string` (≤ 120). Its preview appends `area` to `lines` after the spend line.
  - **All existing payloads stay valid.**
- **`demoTask(now: Date, companyName = 'your roofer'): NewTask`:** the same three steps and titles as now, plus:
  - the message step: `sample: \`Hi Maria, it's ${companyName}. Tuesday's hail hit your street. Want a free roof check this week? Reply YES to book. Reply STOP to opt out.\``, `recipientCount: 31`, `sendTime: 'Today 10:00 AM'`
  - the spend step: `area: 'North side swath · 4.2 sq mi'`
- **`setServiceArea(tx: Tx, geojson: GeoJsonMultiPolygon | null): Promise<void>`:** app_tenant already has `UPDATE (service_area)`. Uses `ST_Multi(ST_GeomFromGeoJSON($1))`.
- **`seedShowcase(pools: Pools, companyId: string, now: Date, opts?: { companyName?: string }): Promise<{ customers: number; properties: number; jobs: number; taskId: string }>`** runs in one `withTenant` with `systemContext(companyId)`:
  - **Service area:** the polygon `[[-96.20,41.17],[-95.90,41.17],[-95.90,41.37],[-96.20,41.37],[-96.20,41.17]]` (Omaha).
  - **Customers and properties:** 60 customers, with names from fixed first/last lists and a seeded PRNG (mulberry32, seed 42). Each customer has a property inside the polygon (`lat`/`lng` rounded to 5 decimals); 10 customers have a second one, so 70 properties in all. Consent `none`, `source: 'manual'`.
  - **Jobs:** 28 jobs on distinct properties: lead 8, inspection 7, proposal 6, won 4, installed 2, lost 1. The leads are unassigned; the rest are assigned to the company's first rep when there is one.
  - **The plan:** `createTask(demoTask(now, companyName))`. Returns the counts and `taskId`.
  - **Same output every run:** two runs on fresh databases give identical names and coordinates.
- **`seedCompany(ownerUrl: string, spec: { name: string; slug: string; timezone?: string; state?: string; users: { email: string; name: string; role: Role; canApproveSpend?: boolean }[]; password: string }): Promise<SeededCompany>`.** `seedTwoCompanies` becomes two calls to it, with identical output to today.
- **`startTestDatabase(): Promise<{ urls: { owner: string; tenant: string; system: string }; stop(): Promise<void> }>`:** the body of the current global setup. The global setup calls it and `provide`s the URLs.
- **`npm run seed:dev -w @roofline/api`** (`seed-dev.ts`):
  - Refuses unless `NODE_ENV=development`.
  - Needs `DATABASE_URL_OWNER`, `DATABASE_URL_TENANT` and `DATABASE_URL_SYSTEM`.
  - When no company has the slug `summit-roofing`, it creates "Summit Roofing" (`America/Chicago`, NE) with these users, all with password `roofline-demo-2026`:
    - `owner@summit.test` (Dana Park, owner)
    - `office@summit.test` (Chris Lane, office, no spend delegation)
    - `rep@summit.test` (Robin Hale, rep)
  - Then runs `seedShowcase`.
  - Prints the sign-in emails, never the password. The README's local-run section names the password, as dev-only test credentials.

- [ ] **Step 1: Write the failing tests**
  - `steps.test.ts`: a `demo_message` with `sample`, `recipientCount` and `sendTime` previews them; a bare `{label}` is still valid; a 641-character `sample` → an error.
  - `showcase.test.ts`:
    - `it('seeds a believable company')` → `{customers:60, properties:70, jobs:28}`. `GET /api/map/area` gives a MultiPolygon, and its bounds equal the polygon. `GET /api/map/pins` over the bounds → 70 customer pins and 25 job pins (lead + inspection + proposal + won). `GET /api/approvals` → `count:1`, with the message step's `preview.recipientCount === 31`.
    - `it('is the same every run')`: reset, seed twice in a row, and compare the sorted names and coordinates.
  - `seed-demo.test.ts`: update the payload expectations.
- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run the full suite and lint**. Expected: PASS, with the F1 tests unchanged.
- [ ] **Step 5: Commit** — `feat: showcase data, dev seed and a richer demo plan`

---

### Task 10: Web: API client, auth pages, router skeleton

**Files:**
- Create: `apps/web/src/api/{client,types,keys,hooks}.ts`, `apps/web/src/app/{router,providers,RequireSession}.tsx`, `apps/web/src/features/auth/{SignIn,ResetPassword,VerifyEmail,AcceptInvite}.tsx`, `apps/web/src/features/auth/safeNext.ts`, `apps/web/src/copy/{errors,auth}.ts`
- Modify: `apps/web/src/main.tsx`
- Test: `apps/web/test/client.test.ts`, `apps/web/test/safe-next.test.ts`, `apps/web/test/auth.test.tsx`

**Interfaces:**
- **Client:**
  - `class ApiError extends Error { status: number; field?: string; latest?: unknown }`
  - `apiFetch<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T>`: JSON in and out, `credentials: 'same-origin'`.
    - A non-2xx response becomes an `ApiError` carrying the body's `error`, `field` and `latest`.
    - A `fetch` rejection becomes `ApiError(0, common.networkError)`.
    - A 401 also calls the registered `onUnauthorized()`.
  - `setUnauthorizedHandler(fn: () => void): void`
- **`types.ts`** mirrors the F1/F2 API shapes with exactly these key names:
  - `Account = { user: {id,email,name,emailVerified}; company: {id,name,slug,status}; role: Role; companies: {id,name}[] }`
  - `StepView`, `TaskView` (incl. `rerunOfTaskId`), `ApprovalsList = { count; tasks }`
  - `CompanyBody`, `TeamBody`
  - `SearchResult`, `PinsResult`, `MapArea`, `CurrentWeather`
  - `StepPreview`/`StepResult`/enums are imported from `@roofline/shared` as types.
- **Query keys (`keys.ts`):** `keys.me`, `keys.approvals`, `keys.task(id)`, `keys.summary`, `keys.attention`, `keys.weather`, `keys.mapArea`, `keys.pins(bboxKey)`, `keys.search(q)`, `keys.company`, `keys.team`.
- **Hooks (`hooks.ts`):** `useMe()`, `useSignIn()`, `useSignOut()`, `useSwitchCompany()`.
  - Signing out or switching company clears every query (`queryClient.clear()` after sign-out; `invalidateQueries()` after a switch).
  - Later tasks add their hooks here.
- **`safeNext(raw: string | null): string`** returns `raw` only when it starts with `/`, does not start with `//` or `/\`, and contains no `:` before the first `/`; otherwise `'/'`.
- **Router** (`createBrowserRouter`):
  - Public: `/sign-in`, `/reset` (request form; with `?token=` the new-password form), `/verify?token=`, `/invite?token=`.
  - Everything else sits under `<RequireSession>`, which waits on `useMe()`. On a 401 it redirects to `/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`.
  - Under it, the shell routes from Task 12. For now, an index route renders a placeholder.
  - `setUnauthorizedHandler` points at the same redirect. Repeated 401s while already redirecting are ignored.
- **Providers:** `QueryClientProvider` (defaults: `retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2`, `refetchOnWindowFocus: true`), `ToastProvider`, and `UiLinkProvider` with a React Router `Link` adapter.
- **Pages:**
  - Sign-in: email, password, Sign in, and a "Forgot your password?" link. After success, `navigate(safeNext(next), { replace: true })`.
  - Reset request: always shows "If that email has an account, we sent a link." after submit.
  - Reset with token: new password (≥ 10), then success with a link to sign in.
  - Verify: posts on mount, then shows done, or the API message.
  - Accept invite: name and password (≥ 10) for a new user. When the API says 401 `inviteSignIn`, show its message and a sign-in link carrying `next=/invite?token=…`.
  - Field errors from `ApiError.field` show on that field.

- [ ] **Step 1: Write the failing tests**
  - `safe-next.test.ts`: `/approvals/x` → itself; `/approvals?x=1` → itself; `//evil.example`, `/\\evil.example`, `https://evil.example`, `javascript:alert(1)`, `''` and `null` → `/`.
  - `client.test.ts` (stub `fetch`): a 409 with `{error,latest}` → `ApiError` with status 409 and `latest`; a 400 with `field: 'email'` → `.field`; a fetch rejection → status 0 with the network message; a 401 calls the handler once.
  - `auth.test.tsx` (`createMemoryRouter`):
    - `it('signs in and goes to next')`: at `/sign-in?next=/approvals/t1`, submitting with a stubbed 200 lands on `/approvals/t1`.
    - `it('ignores an unsafe next')`: `next=//evil.example` → `/`.
    - `it('redirects to sign-in with next when the session is gone')`: `/approvals/t1` with `/api/auth/me` → 401 lands on `/sign-in?next=%2Fapprovals%2Ft1`.
    - `it('shows a field error next to the field')`: 401 badLogin is shown in an alert; 400 with `field:'email'` is shown under Email.
- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run the tests, lint and build** — `npx vitest run --project @roofline/web && npm run lint && npm run typecheck && npm run build:web`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(web): API client, sign-in and email-link pages, session redirect`

---

### Task 11: Web: map home

**Files:**
- Create: `apps/web/src/shell/map/{MapView.tsx,MapView.module.css,mapStyle.ts,pins.ts,PinCard.tsx,PinCard.module.css}`, `apps/web/src/copy/map.ts`
- Modify: `apps/web/src/api/hooks.ts` (`useMapArea`, `useMapPins`), `apps/web/src/copy/legal.ts` (attribution)
- Test: `apps/web/test/map-style.test.ts`, `apps/web/test/pins.test.ts`, `apps/web/test/map-view.test.tsx` (mocks `maplibre-gl`)

**Interfaces:**
- **`mapStyle(env: { maptilerKey?: string; tiles?: string }, mode: 'streets' | 'satellite'): StyleSpecification | string`**
  - With a key: `https://api.maptiler.com/maps/streets-v2/style.json?key=…` or `…/maps/hybrid/style.json?key=…`.
  - With `tiles === 'osm'`: an inline raster style (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`, `tileSize: 256`, `maxzoom: 19`, the attribution from `copy/legal.ts`).
  - Otherwise: a blank style with one `background` layer in `tokens.bg` and no sources.
  - `satelliteAvailable(env): boolean` is true only with a key.
- **`toFeatureCollections(result: PinsResult): { customers: FeatureCollection; jobs: FeatureCollection; clusters: FeatureCollection }`.** The properties carry `kind`, ids, `name`, `addressLine`, `stage`, `stageLabel` and `count`.
- **`CLIENT_CLUSTER_ABOVE = 200`.** When the points shown exceed 200, the GeoJSON sources use `cluster: true` (`clusterRadius: 40`).
- **`MapView({ onOpen(target: { kind: 'customer' | 'job'; id: string }): void })`**, mounted once by the Shell:
  - **Layers:** `service-area` (line, `tokens.text` at 0.5 opacity), `customers` (circle, `tokens['pin-customer']`), `jobs` (circle coloured by `stage` through a `match` on the `stage-*` tokens), `clusters` (a circle sized by count, plus a count symbol layer **only when the style defines `glyphs`**: the blank and OSM styles have none, and a text layer without glyphs errors), and an empty `storm-swath` GeoJSON source with fill layer slot `storm-swath-fill` (Storm Scout fills it). Re-add all of them after every `style.load`, because the satellite toggle swaps styles.
  - **Starting view:** `fitBounds(area.bounds, { padding: 40, maxZoom: 14 })`. With `bounds` null: center `[-96.5, 39.5]`, zoom 3.5.
  - **Pins:** fetch on load and on `moveend`, debounced 300 ms. The bbox is `map.getBounds()`, clamped to valid ranges and rounded to 4 decimals. The query key comes from the rounded bbox.
  - **Clicks:** clicking a customer or job pin shows `PinCard` (name, address, stage label for jobs, and an **Open** `Button` → `onOpen`). Clicking a cluster zooms in (`getClusterExpansionZoom` for client clusters; +2 zoom on a server cluster).
  - **Satellite:** a toggle `Button` shown only when `satelliteAvailable`.
  - **Failure banner:** on the map `error` event for a style, source or tile failure, show a `role="status"` banner: "The map is having trouble loading. Your work is safe." Show it once and do not throw.
  - **Screen-reader summary:** a visually hidden live paragraph, `copy.map.summary(customers, jobs)` → "Map showing 70 customers and 25 open jobs." In clusters mode it is `copy.map.summaryClusters(total)`.
  - **Region:** the map container is `role="region"` with `aria-label={copy.map.label}`. MapLibre's own controls are kept: zoom (`NavigationControl`) and attribution.
- **Env:** `import.meta.env.VITE_MAPTILER_KEY` and `VITE_MAP_TILES` are read only in `mapStyle`'s caller.

- [ ] **Step 1: Write the failing tests**
  - `map-style.test.ts`: key + satellite → hybrid URL; `osm` → raster with attribution; nothing → a style with zero sources; `satelliteAvailable({})` is false.
  - `pins.test.ts`: points → features at `[lng, lat]` with `stage`; clusters → features with `count`.
  - `map-view.test.tsx` (with `vi.mock('maplibre-gl')`: a fake Map class recording `addSource`, `addLayer`, `fitBounds` and `on`, and able to emit events):
    - `it('fits the service area')` and `it('starts at the US view without bounds')`.
    - `it('turns on client clustering above 200 points')`: 201 points → the `customers` source is added with `cluster: true`.
    - `it('shows the banner on a tile error and keeps working')`.
    - `it('summarizes what is on the map')`: with `/api/map/pins` stubbed to 70/25 → text "Map showing 70 customers and 25 open jobs."
    - `it('opens the pin card and Open calls onOpen')`: emit `click` on the `jobs` layer with a feature → the card shows the name and "Proposal"; Open calls `onOpen({kind:'job', id})`.
- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement**. `maplibre-gl/dist/maplibre-gl.css` is imported once in `MapView.tsx`.
- [ ] **Step 4: Run the tests, the lints and the build**. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(web): map home with pins, clustering, satellite and a failure banner`

---

### Task 12: Web: shell (top bar, dock, windows, search, user menu)

**Files:**
- Create: `apps/web/src/shell/{Shell.tsx,Shell.module.css,AppWindow.tsx,apps.ts,useIsPhone.ts}`, `apps/web/src/shell/topbar/{ShellTopBar,OkPill,AgentsWorking,WeatherChip,SearchDialog,UserMenu}.tsx` (+ CSS Modules), `apps/web/src/features/coming-soon/ComingSoon.tsx`, `apps/web/src/features/storm/StormWindow.tsx`, `apps/web/src/copy/{shell,dock,search,comingSoon,storm}.ts`
- Modify: `apps/web/src/app/router.tsx`, `apps/web/src/api/hooks.ts` (`useApprovals`, `useTasksSummary`, `useAttentionCount`, `useWeather`, `useSearch`)
- Test: `apps/web/test/shell.test.tsx`, `apps/web/test/search-dialog.test.tsx`, `apps/web/test/ok-pill.test.tsx`

**Interfaces:**
- **App definitions (`apps.ts`):**
  - `AppKey = 'storm'|'front-desk'|'estimator'|'jobs'|'calendar'|'agents'`
  - `DOCK_APPS: readonly { key: AppKey; href: string; icon: ReactNode; shipped: false }[]`, in dock order: Storm, Front Desk, Estimator, Jobs, Calendar, Agents.
  - `WINDOW_COPY: Record<AppKey | 'today' | 'approvals' | 'settings' | 'customers' | 'notFound', { title: string; description: string }>` comes from `copy/dock.ts`:
    - Storm, "Hail maps and storm plans"
    - Front Desk, "Answers every call and text"
    - Estimator, "Roof estimates and proposals"
    - Jobs, "Every job from lead to paid"
    - Calendar, "Inspections and installs"
    - Agents, "What your agents did today"
    - Need your OK, "Plans your agents drafted, waiting for a yes"
    - My day, "What needs you today"
    - Settings, "Your company, team and accounts"
    - Customer, "Customer details"
    - Not found, "We couldn't find that page"
- **Badges** (from the queries):
  - Storm: the counted drafts with `agent === 'storm_scout'`
  - Estimator: the counted drafts with `agent === 'estimator'`
  - Agents: `useAttentionCount()`, the length of `GET /api/tasks?status=needs_attention&limit=200`
  - the others: none
  - "Counted drafts" means `ApprovalsList.tasks` with status `draft` or `awaiting_owner` and `expired === false`.
- **`useIsPhone(): boolean`:** `matchMedia('(max-width: 767.98px)')` through `useSyncExternalStore`. It is false where `matchMedia` is missing. Task 17 builds the phone shell on it.
- **`AppWindow({ app, children, stats? })`:** renders `Window` titled from `WINDOW_COPY[app]`, `variant` from `useIsPhone()` (phone → `'page'`), `onClose: () => navigate('/')`, `closeLabel: common.close`. Keyed by `app`, so opening another app replaces the window.
- **Router children** of the session route:
  - `index`: nothing (map home)
  - `today`: Task 15
  - `approvals` and `approvals/:taskId`: Task 14; Task 12 renders `ComingSoon` placeholders in their slots
  - `storm`: `StormWindow`
  - `storm/plans/:taskId`: Task 14's `Review` inside the Storm window
  - `storm/*`, `front-desk/*`, `estimator/*`, `jobs/*`, `calendar/*`, `agents/*`, `customers/*`: `ComingSoon`
  - `settings` and `settings/:tab`: Task 16
  - `*`: the Not found window
- **`ComingSoon({ app })`:** an `EmptyState` with the app's coming-soon line from `copy/comingSoon.ts`.
- **`StormWindow`:** `ComingSoon` plus, when the newest counted `storm_scout` draft exists, a `Card` with its title, summary and a primary `Button` "Approve storm plan" → `/storm/plans/${id}`.
- **`OkPill`:**
  - Hidden when `count === 0`.
  - The label is `copy.shell.needYourOk(count)` → `${n} need your OK`.
  - `href`: with exactly one counted draft, `/approvals/${id}`; otherwise `/approvals`.
- **`AgentsWorking`:** `copy.shell.agentsWorking(working)` → 0: "All quiet"; 1: "1 agent working"; n: `${n} agents working`. From `GET /api/tasks/summary`, refetched every 30 s.
- **`WeatherChip`:** hidden when `weather` is null or the query errors. Otherwise an icon plus `${tempF}°` plus the summary, truncated with an ellipsis. Refetched every 30 min.
- **`SearchDialog`:**
  - ⌘K (mac) or Ctrl+K opens it from anywhere, including while typing in an input (`keydown` on `window`, `preventDefault`). A top-bar search `IconButton` also opens it.
  - The input is debounced 200 ms; at least 2 characters shows results grouped as Customers, Jobs and Addresses (each heading from copy).
  - ↑/↓ move through the results (`aria-activedescendant` on a `role="combobox"` input with a `role="listbox"`); Enter opens the active one.
  - Targets: a customer → `/customers/${id}`; a job → `/jobs/${id}`; an address → `/customers/${customerId}`.
  - Esc closes it. Under 2 characters it shows a hint; with no matches, "No matches for “{q}”".
- **`UserMenu`:** `Avatar` plus the name opens a menu (a `Sheet` on phone, a popover `Card` on desktop) with:
  - My day → `/today`
  - Settings → `/settings/company`
  - one entry per other company (switch) when `companies.length > 1`
  - Sign out
- **Shell layout:** `TopBar` on top, then the map, then `<Outlet />` inside the window, then the `Dock` at the bottom center. The Dock marks `current` from the first path segment. When a pin card's Open is used: `navigate('/customers/'+id)` or `'/jobs/'+id`.
- **Polling:** approvals are refetched every 30 s and on window focus.

- [ ] **Step 1: Write the failing tests** (memory router with stubbed `fetch` routes; `maplibre-gl` mocked)
  - `shell.test.tsx`:
    - `it('shows six labeled dock apps')`: `within(getByRole('navigation', {name: copy.dock.label})).getAllByRole('link')` gives the 6 labels in order.
    - `it('opens each app in one centered window with its own URL')`: clicking Storm gives the dialog named Storm and the router location `/storm`; then clicking Jobs gives the dialog Jobs and one dialog in the document.
    - `it('Esc and ✕ go to the map')`: at `/jobs`, Esc → `/` with no dialog; at `/jobs`, a click on Close → `/`.
    - `it('deep-links straight to a window')`: the initial entry `/calendar` shows the dialog Calendar.
    - `it('badges Storm with storm drafts and Agents with tasks needing attention')`.
    - `it('Storm window offers the storm plan')`: one storm draft → "Approve storm plan" links to `/storm/plans/t1`.
    - `it('hides the weather when there is none or it fails')`: `{weather:null}` and a 500 both render no weather chip and no error toast.
  - `ok-pill.test.tsx`: count 0 → no pill; one counted draft (plus one expired) → the link "1 need your OK" with href `/approvals/t1`; two → href `/approvals`.
  - `search-dialog.test.tsx`:
    - `it('opens on Ctrl+K even from a text field')`.
    - `it('groups results and opens the active one with Enter')`: type "lop", ArrowDown, Enter → `/customers/c1`.
    - `it('waits for 2 characters')`.
    - `it('shows no matches')`.
    - `it('sends the query as typed, encoded')`: "o'neil %" is requested as `q=o'neil%20%25` (URLSearchParams).
- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run the tests, the lints and the build**. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(web): shell with top bar, dock, windows, search and user menu`

---

### Task 13: End-to-end harness and shell tests

**Files:**
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/stack.ts`, `apps/web/e2e/fixtures.ts`, `apps/web/e2e/shell.spec.ts`
- Modify: `apps/web/package.json` (`e2e` script and devDependencies: `@playwright/test`, `@axe-core/playwright`, `pg`, `tsx`), root `package.json` (script `e2e`), `.github/workflows/ci.yml` (an e2e job: `npx playwright install --with-deps chromium`, `npm run e2e`)

**Interfaces:**
- **`e2e/stack.ts`**, run by Playwright's `webServer`; it must stay in the foreground:
  1. `startTestDatabase()` (`@roofline/db/testing`).
  2. Write `e2e/.stack.json` = `{ ownerUrl, tenantUrl, systemUrl, baseUrl: 'http://127.0.0.1:4410' }`.
  3. `resetScenario(urls)` from `fixtures.ts`.
  4. Spawn the API with `tsx apps/api/src/server.ts` and env:
     - `NODE_ENV=test`, `PORT=4410`, `HOST=127.0.0.1`
     - `APP_ORIGIN=PUBLIC_BASE_URL=http://127.0.0.1:4410`
     - the tenant and system URLs, a random `ENCRYPTION_KEY`, `WEATHER_DISABLED=1`
     - `WEB_DIST_DIR=<repo>/apps/web/dist`
  5. Spawn the worker with `tsx apps/worker/src/index.ts` and the same env.
  6. On SIGINT or SIGTERM: kill both children and `stop()` the database.
  7. Pipe the children's output with a `[api]`/`[worker]` prefix.
- **Weather in end-to-end runs:** both children get `WEATHER_DISABLED=1` (Task 8), so the suite never calls the weather service.
- **`fixtures.ts`:**
  - `resetScenario(urls): Promise<Scenario>`: `resetDb(owner)`, `seedTwoCompanies(owner)`, then `seedShowcase(pools, a.id, new Date(), { companyName: 'Acme Roofing' })`. `pools` comes from `createPools` (`@roofline/db`) on the tenant and system URLs, made once and reused.
  - `Scenario = { a: SeededCompany; taskId: string }`
  - a Playwright `test` extended with:
    - `scenario`: auto, per test, which resets first
    - `loginAs(page, who: 'owner'|'office'|'rep')`: `page.request.post('/api/auth/login', { data, headers: { Origin: baseUrl } })`
    - `db`: a `pg.Client` on `ownerUrl`
    - `clicks`: a counter, with a `click(locator)` helper that increments it
    - `markTodaySeen(email)`: SQL `update memberships set last_today_shown_on = (now() at time zone 'America/Chicago')::date where user_id = (select id from users where email = $1)`
- **`playwright.config.ts`:**
  - `testDir: 'e2e'`, `workers: 1`, `fullyParallel: false`, `use.baseURL: 'http://127.0.0.1:4410'`
  - `webServer: { command: 'npx tsx e2e/stack.ts', url: 'http://127.0.0.1:4410/health', timeout: 300_000, reuseExistingServer: false, stdout: 'pipe' }`
  - projects:
    - `desktop`: viewport 1440×900, `testIgnore: /phone\.spec/`
    - `phone`: `devices['Pixel 7']` with viewport 375×812, `testMatch: /phone\.spec/`
- **Scripts:**
  - `apps/web` `e2e`: `npm run build && playwright test`. The build runs without `VITE_*` env, so the blank map style is used.
  - root `e2e`: `npm run e2e -w @roofline/web`.

- [ ] **Step 1: Write the failing tests** (`shell.spec.ts`; every test logs in as owner and calls `markTodaySeen` unless it is testing Today)
  - `test('map home shows the seeded pins')`: `goto('/')` → `getByText('Map showing 70 customers and 25 open jobs.')` is attached.
  - `test('dock has six labeled apps that each open one window with its own URL')`: for each label: click → `toHaveURL(/\/storm$/…)` and `getByRole('dialog')` has count 1 and the app's name. The dialog's bounding box is centered (|left − right margin| ≤ 2px) and at most 1280×860.
  - `test('Esc and ✕ go home, Back goes to the previous window')`: Storm → Jobs → `goBack()` → `/storm` with the Storm dialog. Esc → `/`. Open Jobs, click Close → `/`.
  - `test('deep link opens the review directly')`: `goto('/approvals/' + scenario.taskId)` → dialog "Need your OK" containing "Storm plan: hail on the north side". Task 13 asserts the dialog and title only; Task 14 extends this test.
  - `test('focus stays inside the window')`: open Jobs; press Tab 15 times; after each press, `document.activeElement` is inside `[role=dialog]`.
  - `test('pill shows the live draft count')`: "1 need your OK"; then insert a second draft via the db fixture (`seedDemoTask`) and reload → "2 need your OK".
- [ ] **Step 2: Run them and see them fail** — `npm run e2e -- --project desktop`.
- [ ] **Step 3: Implement the stack, fixtures and config** (and fix any shell defects the run exposes).
- [ ] **Step 4: Run the e2e suite and the unit suite** — `npm run e2e -- --project desktop && npx vitest run`. Expected: all PASS.
- [ ] **Step 5: Commit** — `test(e2e): self-contained stack and shell tests`

---

### Task 14: Web: approvals list and the review screen

**Files:**
- Create: `apps/web/src/features/approvals/{ApprovalsList,Review,EditStepSheet,NotNowSheet}.tsx`, `apps/web/src/features/approvals/{toReviewStep,editable}.ts`, `apps/web/src/copy/{approvals,review}.ts`, `apps/web/e2e/approvals.spec.ts`
- Modify: `apps/web/src/app/router.tsx` (the approvals routes, `storm/plans/:taskId`), `apps/web/src/api/hooks.ts` (`useTask`, `useEditStep`, `useApprove`, `useDecline`, `useRetryStep`, `useRerun`), `apps/web/e2e/shell.spec.ts` (finish the deep-link test)
- Test: `apps/web/test/to-review-step.test.ts`, `apps/web/test/review.test.tsx`, `apps/web/test/review-copy.test.ts`

**Interfaces:**
- **`toReviewStep(step: StepView, task: TaskView): ReviewStep`:**
  - `open`: the caller has a decision on this step. That is `status === 'pending'` while the task is `draft`, or `status === 'awaiting_owner'` while the task is `awaiting_owner`. Confirm these against the open-step rule in `approveTask` (`apps/api/src/tasks/service.ts:476`); if the API differs, follow it.
  - `title`: `step.preview.title`.
  - `editable`: `editableText(step) !== null`.
- **`editableText(step: StepView): { key: 'sample' | 'body'; value: string } | null`:**
  - `demo_message` → `payload.sample`
  - `send_sms_batch` → `payload.body`
  - anything else → null
- **Review mode:** `'review'` when the task is not expired, its status is `draft` or `awaiting_owner`, and some step is `open`. Otherwise `'progress'`.
- **Review copy (`copy/review.ts`):**
  - `approveButton(s)`:
    - `ownerSteps > 0 && count > 0` → `Approve ${count} ${step(s)} · send ${ownerSteps === 1 ? 'ad' : ownerSteps + ' steps'} to owner`
    - `ownerSteps > 0 && count === 0` → `Send to owner`
    - `maxSpendCents > 0` → `Approve ${count} ${step(s)} · up to ${dollars}`
    - otherwise `Approve ${count} ${step(s)}`
    - `step(s)` is "step" when 1, else "steps"; `dollars` is a whole-dollar `Intl.NumberFormat('en-US', {style:'currency', currency:'USD', maximumFractionDigits: 0})`
  - `nothingOn`: "Turn on a step to approve"
  - `notNow`: "Not now"
  - `footerNoteSpend`: "Ad spend comes from your connected ad accounts."
  - `footerNote`: "Nothing goes out until you approve."
  - `ownerApprovesSpending`: "Your owner approves spending"
  - `waitingForOwner`: "Waiting for owner"
  - `recipients(n)`: `${n} customers`
  - `sendTime(t)`: `Sends ${t} · quiet hours respected`
  - `spend(c)`: `Up to ${dollars}`
  - `resultLines(r)`: each numeric key mapped through a plain map (sent → "sent", delivered → "delivered", failed → "couldn't send", blocked → "held back", replies → "replies", booked → "inspections booked"; unknown keys skipped) as `${n} ${word}`
  - `stepStatus`: `stepStatusLabel`
- **`Review({ taskId })`:**
  - Loads with `useTask`.
  - Refetches every 2 s while any step is `queued` or `running`, or for 10 s after an approve. Otherwise it does not poll.
  - **Toggle** → `PATCH /api/approvals/:taskId/steps/:stepId {version, enabled}`, optimistic, with the step id in `pendingStepIds` until it settles.
  - **Edit** → `EditStepSheet`: a multiline `Field` holding the text. Save → `PATCH {version, payload: {...payload, [key]: text}}`. A 400 shows the error on the field.
  - **Approve** → `POST /approve {steps: open steps' {id, version}}`.
    - The button is `busy` while pending, and a second click is ignored (mutation `isPending` guard).
    - On success the view switches to progress in the same window.
  - **Not now** → `NotNowSheet` with an optional reason (≤ 500) and a confirm "Not now". It POSTs decline, then toasts `copy.approvals.declined` and navigates to `/approvals` when more drafts remain, else to `/`.
  - **Any 409:** set the cached task to `error.latest` (when it is a TaskView; a step 409 carries a StepView, so refetch the task) and toast the API message.
  - **Retry** → POST retry.
  - **Expired task:** an `EmptyState` "This plan expired" with a primary "Run it again" → POST rerun → navigate to the new task's URL (under the same window: `/approvals/` or `/storm/plans/`).
  - **404:** the Not found empty state.
  - **Window stat strip:** the task's agent label, then `taskStatusLabel(task)`, then the time it was created.
- **`ApprovalsList`:**
  - `GET /api/approvals` tasks, newest first. Each is a `Card` link → `/approvals/:id`, showing the agent label, title, summary (two lines, ellipsis) and status label. Expired drafts show "Expired".
  - Empty → `EmptyState` "Nothing needs your OK."
  - For a rep → `EmptyState` "Approvals are for owners and office staff."

- [ ] **Step 1: Write the failing tests**
  - `review-copy.test.ts`:
```ts
expect(approveButton({ count: 3, maxSpendCents: 27000, ownerSteps: 0 })).toBe('Approve 3 steps · up to $270');
expect(approveButton({ count: 2, maxSpendCents: 0, ownerSteps: 1 })).toBe('Approve 2 steps · send ad to owner');
expect(approveButton({ count: 1, maxSpendCents: 0, ownerSteps: 0 })).toBe('Approve 1 step');
expect(approveButton({ count: 0, maxSpendCents: 0, ownerSteps: 1 })).toBe('Send to owner');
```
  - `to-review-step.test.ts`: the open rule for draft, awaiting_owner and done tasks; `editable` for demo_message with and without `sample`.
  - `review.test.tsx` (stubbed fetch):
    - `it('turning a step off leaves it out')`: PATCH sent with `enabled:false`; the button reads "Approve 2 steps"; the approve body lists all 3 steps' ids and versions.
    - `it('a 409 reloads the latest and says so')`: approve → 409 with `latest` (one step now disabled) → the toast text is the API message and the view shows the latest.
    - `it('a double click approves once')`.
    - `it('Not now declines with a reason')`.
    - `it('an expired plan offers Run it again')` → POST rerun → navigate to `/approvals/new-id`.
    - `it('a rep sees the owners-only empty state')`.
  - `approvals.spec.ts` (e2e):
    - `test('one draft: pill to approved in 2 clicks')`:
```ts
await loginAs(page, 'owner'); await markTodaySeen('owner@a.test'); await page.goto('/');
await click(page.getByRole('link', { name: '1 need your OK' }));
await click(page.getByRole('button', { name: 'Approve 3 steps · up to $270' }));
await expect(page.getByRole('dialog').getByText('Done')).toHaveCount(3, { timeout: 15_000 });
expect(clicks.count).toBe(2);
```
    - `test('from the Storm window: 2 clicks')`: `goto('/storm')`, click "Approve storm plan", click "Approve 3 steps · up to $270" → 3 × Done; `clicks.count === 2`.
    - `test('turning a step off excludes it')`: switch off "Door-knock routes for 4 reps" → "Approve 2 steps · up to $270" → after approve, that row shows "Turned off" and the other two "Done".
    - `test('office approves two, the ad waits for the owner')`: the office logs in, opens the plan; the spend row shows "Your owner approves spending"; the button is "Approve 2 steps · send ad to owner"; click → two rows "Done" (live, no reload) and the spend row "Waiting for owner". Then the owner logs in → "1 need your OK" → opens it → the button is "Approve 1 step · up to $270".
    - `shell.spec.ts` deep-link test: now also asserts the Approve button is visible and the Today window did not open.
- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run the unit and e2e suites** — `npx vitest run --project @roofline/web && npm run e2e -- --project desktop`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(web): approvals list and the review screen with live results`

---

### Task 15: Web: Today window

**Files:**
- Create: `apps/web/src/features/today/{Today.tsx,Today.module.css}`, `apps/web/src/copy/today.ts`, `apps/web/e2e/today.spec.ts`
- Modify: `apps/web/src/shell/Shell.tsx` (auto-open), `apps/web/src/app/router.tsx`, `apps/web/src/api/hooks.ts` (`useCompany`, `useTodayShown`)
- Test: `apps/web/test/today.test.tsx`

**Interfaces:**
- **Auto-open:** once per page load, after `useMe()` resolves, the Shell checks whether the location at first render was exactly `/`.
  - If it was, it POSTs `/api/me/today-shown`; on `{show:true}` it calls `navigate('/today')`.
  - **A deep link never triggers it**, so it never hijacks a link from a text or email.
  - A ref guards against StrictMode's double effect.
- **`Today`:**
  - **Greeting:** `copy.today.greeting(part, firstName)`, where `part` comes from the hour in the company's time zone (`GET /api/company` → `timezone`): before 12 "Good morning", before 17 "Good afternoon", otherwise "Good evening". `firstName` is the first word of `user.name`. The result reads `Good morning, Dana`.
  - **Date line:** in the company zone (`Intl.DateTimeFormat('en-US', { weekday:'long', month:'long', day:'numeric', timeZone })`).
  - **"Need your OK":** the top 3 counted drafts, each a `Card` link to `/approvals/:id` with the agent label and title. With none: "Nothing needs your OK right now." With more than 3: a "See all N" link to `/approvals`.
  - **"Today's appointments":** `EmptyState` "No appointments yet. Your calendar is coming soon."
  - **Reopening:** from the user menu's "My day" item (Task 12).

- [ ] **Step 1: Write the failing tests**
  - `today.test.tsx`:
    - `it('greets by first name in the company time zone')`: fake time 2026-10-12T14:00Z with Chicago (09:00) → "Good morning, Dana".
    - `it('lists the top 3 drafts')`: 5 drafts → 3 cards and "See all 5".
    - `it('auto-opens only from the map home')`: initial `/` with `{show:true}` → `/today`; initial `/jobs` → no POST is made.
  - `today.spec.ts` (e2e, no `markTodaySeen`):
    - `test('opens once per day, again the next day')`:
      - `goto('/')` → URL `/today` and the dialog "My day" with "Good"; Esc → `/`.
      - `goto('/')` → stays `/` (no dialog).
      - Time travel: `db.query("update memberships set last_today_shown_on = last_today_shown_on - 1 where user_id = …")`.
      - `goto('/')` → `/today`.
    - `test('a deep link does not open Today')`: `goto('/jobs')` → the Jobs dialog; then `goto('/')` → `/today` (it had not been shown yet that day).
- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run the unit and e2e suites**. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(web): Today window, once per day per person`

---

### Task 16: Web: Settings (Company and Team)

**Files:**
- Create: `apps/web/src/features/settings/{Settings,CompanyTab,TeamTab,LaterTab}.tsx` (+ CSS Modules), `apps/web/src/copy/settings.ts`
- Modify: `apps/web/src/copy/{connections,billing,setup}.ts`, `apps/web/src/app/router.tsx`, `apps/web/src/api/hooks.ts` (`useUpdateCompany`, `useTeam`, `useInvite`, `useUpdateMember`; it reuses Task 15's `useCompany`)
- Test: `apps/web/test/settings.test.tsx`

**Interfaces:**
- **`/settings`** redirects to `/settings/company`. **`/settings/:tab`**, with tab one of `company`, `team`, `connections`, `billing` or `setup`, renders tabs as links with `aria-current`. An unknown tab redirects to `company`.
- **`CompanyTab`:**
  - **Fields:** name, phone, email, website, street, city, state, ZIP, and time zone (`Select` of the US zones: `America/New_York`, `America/Chicago`, `America/Denver`, `America/Phoenix`, `America/Los_Angeles`, `America/Anchorage`, `Pacific/Honolulu`, `America/Indiana/Indianapolis`, `America/Kentucky/Louisville`, `America/Detroit`, `America/Boise`), plus its current value when it is not in the list.
  - **Owner:** can edit. Save sends a `PATCH /api/company` with only the changed keys (an empty string clears a field). Success → toast "Saved". A 400 with `field` shows the error under that field.
  - **Everyone else:** the same fields, read-only, with the note "Only the owner can change company details."
- **`TeamTab`:**
  - **Members table:** name, email, role, "Can approve spending" (Toggle), and status (Active, or Turned off).
  - **Owner:**
    - changes role (`Select`), spend delegation (Toggle; for office members only) and status ("Turn off" / "Turn back on" Button), each via `PATCH /api/team/members/:id`
    - invites with email plus a role `Select` → `POST /api/team/invites`; success → the toast "Invite sent to {email}"
    - pending invites are listed with their expiry date
    - API errors (`lastOwner`, `alreadyOnTeam`, `verifyEmailFirst`) show in a toast or under the field
  - **Others:** a read-only list without invites.
- **`LaterTab({ tab })`:** connections, billing and setup each show an `EmptyState` with their copy from `copy/connections.ts`, `copy/billing.ts` and `copy/setup.ts` (for example "Connect your Google and Facebook ad accounts here. Coming with setup."). These files are where vendor names are allowed.
- **Role labels:** owner "Owner", office "Office", rep "Field rep". They live in `copy/settings.ts` and are passed to the `Select`s.

- [ ] **Step 1: Write the failing tests** (`settings.test.tsx`):
  - `it('owner saves only what changed')`: change the phone → the PATCH body is exactly `{ phone: '…' }`.
  - `it('shows the field error from the server')`: 400 with `field:'website'` → the error under Website.
  - `it('office sees read-only company details')`: the inputs are read-only, the note is shown, and there is no Save button.
  - `it('owner invites a teammate')`, `it('owner turns on spend approval for an office member')`, `it('last owner error shows as a toast')`.
  - `it('later tabs say what is coming')`: `/settings/billing` shows the billing copy.
  - `it('unknown tab goes to company')`.
- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run the tests, the lints and the build**. Expected: PASS, including the copy-rules test with the new vendor strings.
- [ ] **Step 5: Commit** — `feat(web): settings for company details and team`

---

### Task 17: Phone layout, accessibility scans, CI and acceptance map

**Files:**
- Create: `apps/web/src/shell/phone/{BottomTabs,MoreSheet}.tsx` (+ CSS Modules), `apps/web/e2e/phone.spec.ts`, `apps/web/e2e/a11y.spec.ts`, `docs/superpowers/f2-acceptance.md`
- Modify: `apps/web/src/shell/Shell.tsx` (phone branch), `apps/web/src/shell/AppWindow.tsx`, `apps/web/src/copy/shell.ts`, `.github/workflows/ci.yml`, `docs/superpowers/f1-followups.md` (mark the F2 items that were done and move the rest)
- Test: `apps/web/test/phone.test.tsx`

**Interfaces:**
- Consumes: `useIsPhone()` (Task 12).
- **Phone shell:**
  - **No dock.** The top bar is compact: logo, `OkPill`, a search `IconButton` and the user `Avatar`. The agents-working text and the weather are hidden.
  - **`BottomTabs`:** a `<nav aria-label>` with five 48px-tall links: My day `/today` · Map `/` · Jobs `/jobs` · Calendar `/calendar` · More (a button-like link that opens `MoreSheet`). It uses `aria-current`.
  - **`MoreSheet`:** a `Sheet` listing Storm, Front Desk, Estimator, Agents and Settings as links. Choosing one closes it.
  - **Windows render as `variant="page"`:** full-screen above the bottom tabs. The review footer stays pinned (Task 5's sticky footer).
  - **No horizontal scroll at 375px.** Long text truncates (`min-width: 0`, `overflow-wrap: anywhere`, `text-overflow: ellipsis` where single-line).
- **Accessibility scans (`a11y.spec.ts`):** `new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa'])`. The test fails on any violation with impact `serious` or `critical`.
  - It scans the map home (shell), `/approvals`, and `/approvals/:taskId`.
  - **Exclusions:** only `.maplibregl-ctrl-attrib`, and only if MapLibre's own attribution control fails contrast. Record the reason in a comment.
- **CI:** the e2e job runs both Playwright projects. Upload `playwright-report` when it fails.
- **`f2-acceptance.md`:** maps each §4.8 bullet to its test (file and test name), the way `f1-acceptance.md` does.

- [ ] **Step 1: Write the failing tests**
  - `phone.test.tsx` (`matchMedia` mocked to phone): the bottom tabs show 5 items and no dock; More opens a sheet with 5 links; windows have `data-variant="page"`.
  - `phone.spec.ts` (e2e, phone project):
    - `test('bottom tabs work')`: Map, My day, Jobs and Calendar each go to their URL; More → Storm → `/storm`.
    - `test('no horizontal scroll')`: at `/`, `/approvals` and `/approvals/:id`, `document.documentElement.scrollWidth <= 375`.
    - `test('Approve stays pinned')`: on `/approvals/:id`, the Approve button's box is inside the viewport (`box.y + box.height <= 812 - bottomTabsHeight`). After `mouse.wheel(0, 2000)` it is still inside.
    - `test('long text does not widen the page')`: update a seeded customer's name to 60 characters and the demo step's `sample` to 400 characters via SQL, then open the review → still `scrollWidth <= 375`.
  - `a11y.spec.ts` (desktop): the three scans have no serious or critical violations.
- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement** (and fix whatever the axe scans and the 375px checks surface).
- [ ] **Step 4: Run everything**:
  - `npm run lint && npm run lint:css && npm run typecheck && npx vitest run && npm run e2e`
  - `(cd v1 && npm test)`: v1 must still pass.
  - Expected: all PASS.
- [ ] **Step 5: Commit** — `feat(web): phone layout, accessibility scans, CI e2e and the F2 acceptance map`

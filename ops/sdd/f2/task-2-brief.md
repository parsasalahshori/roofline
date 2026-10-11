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


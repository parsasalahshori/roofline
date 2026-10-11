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


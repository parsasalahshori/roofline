# Task 3 report: Design kit primitives

Status: DONE (with the concerns listed at the end).
Commit: `6608663 feat(ui): primitives (button, toggle, field, select, badge, pill, cards)` on `f2-shell`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `package-lock.json` is in the commit.

## What I implemented

All in `packages/ui/src`, one folder per component with a CSS Module (tokens only for colours, radii, shadows; font sizes via `var(--font-size-*)`, `rem` or px >= 12).

- `link.tsx`: `UiLinkProvider({ component, children })`, `UiLink`, types `UiLinkProps` and `UiLinkComponent`. A React context holds the component; `UiLink` renders it, or a plain `<a>` when no provider is mounted.
- `pressable.tsx` (internal, not exported): the shared core of Button, IconButton and Pill.
  - Without `href` it renders `<button type="button">`. `busy` or `disabled` sets `disabled`, and `busy` also sets `aria-busy="true"`.
  - With `href` it renders `UiLink`. When busy or disabled it sets `aria-disabled="true"` (and `aria-busy` when busy), calls `preventDefault` and does not call the caller's `onClick`.
- `cx.ts` (internal): class-name joiner.
- `Button`: `variant` (primary default, ghost, danger), `size` (md default, lg), `busy`, `href`. It sets `data-variant` and `data-size`. `min-height` is 40px (48px for lg). Primary is `--accent` with `--accent-ink`, danger is `--danger` with white bold text, ghost is transparent with a `--line` hover.
- `IconButton`: `label` becomes `aria-label`; the icon sits in an `aria-hidden` span; 40x40 minimum; `href` is supported through the same core.
- `Card`: `as` ('div' default, 'section', 'li'), `padded`; exposes `data-padded`. It also accepts HTML attributes, for example `aria-label`.
- `StatCard`: Card plus a one-pair `<dl>` (label, value, hint). The value is 24px (`--font-size-stat`) with `tabular-nums`.
- `Toggle`: `<button type="button" role="switch" aria-checked data-state="on|off">`. The label is the visible text, or the `aria-label` when `labelHidden`. Click calls `onChange(!checked)`; `disabled` is a native disabled button. The track and thumb change position as well as colour.
- `Field`: `useId()` unless `id` is given. The label is tied with `htmlFor`. `aria-describedby` lists the help and error ids (plus any the caller passed). The error is `<p role="alert">` and the control gets `aria-invalid="true"`. `multiline` renders a textarea with `rows`.
- `Field/fieldParts.tsx`: `useFieldA11y` and `FieldMessages`, shared by Field and Select so the two behave the same.
- `Select`: a native `<select>` with the same label, help and error wiring as Field. `onChange(value)`, `options`, `disabled`, optional `id` and `className`.
- `Badge`: renders nothing for `count <= 0` or NaN. Above 99 it shows `99+`. It is `role="img"` with `aria-label={label}`, so `getByRole('img', { name })` and `getByLabelText` both reach it.
- `Pill`: a link through `UiLink` with `href`, otherwise a `<button type="button">`. `tone` accent (default) or neutral, exposed as `data-tone`. 32px high, 40px under `max-width: 767.98px`.
- `Avatar`: initials of the first and last word, uppercased (Unicode-safe), `aria-hidden`. `size` 24, 32 (default) or 40, exposed as `data-size`.
- `Skeleton`: `width`, `height`, `lines`. `aria-hidden`; each line has `data-part="line"` and the last is 60% wide; the pulse animation is switched off by base.css under reduced motion.
- `EmptyState`: title, optional body, optional action.
- `index.ts`: exports every component and its prop types, plus `UiLink`, `UiLinkProvider`, `UiLinkProps`, `UiLinkComponent`.
- `test/setup.ts`: added `afterEach(cleanup)`. Vitest runs without globals here, so Testing Library cannot register its own cleanup.
- `packages/ui/package.json`: devDependencies `@testing-library/react@^16.3.3` and `@testing-library/user-event@^14.6.7`. No nested `node_modules` was created (only the existing `apps/web/node_modules` is there), so the `xattr` step was not needed.

## Tests and results

`packages/ui/test/primitives.test.tsx`: 46 tests. They cover every case in the brief, plus:
- UiLink default `<a>` and provided component
- Button variants, size and type, an idle link, a busy link whose click is cancelled (`fireEvent.click` returns false)
- IconButton click, link and hidden icon
- Card `as` and `padded`, StatCard with and without a hint
- Toggle off state, keyboard flip with Space, and `labelHidden`
- Field: no describedby without help or error, help only, unique and explicit ids, textarea, typing
- Select: help and error wiring, disabled
- Badge 99 versus 99+
- Pill as a button and as a link through the provider
- Avatar: middle names, whitespace, size
- Skeleton lines, EmptyState with a title only

Final verification, all green:
- `npx vitest run --project @roofline/ui`: 3 files, 69 tests passed.
- `npm run lint`, `npm run lint:css`, `npm run typecheck`: clean.
- Full `npx vitest run`, run once before the commit: 46 files, 2135 tests passed. The F1 flake in `rep-visibility.test.ts` did not occur.
- After the full run I made one small edit: `Field` now passes `type` only to the input, not the textarea. I re-ran the ui project, lint, lint:css and typecheck afterwards, all green; I did not re-run the full suite.
- I also ran a Vite library build of `packages/ui/src/index.ts` (output in the scratchpad, not committed). All CSS Modules compile and bundle to 6 KB of CSS.

## TDD evidence

RED, after writing `primitives.test.tsx` and `setup.ts`, with no components yet:

```
$ npx vitest run --project @roofline/ui
 FAIL  |@roofline/ui| test/primitives.test.tsx > UiLink > renders a plain anchor when no provider is mounted
Error: Element type is invalid: expected a string (for built-in components) or a class/function ... but got: undefined.
 ...
 Test Files  1 failed | 2 passed (3)
      Tests  46 failed | 23 passed (69)
```

All 46 new tests failed for the expected reason: every kit import was `undefined`.

GREEN, after implementing, one test failed:

```
 Skeleton > is hidden from assistive tech
 - height: 2rem;  + height: 32px;      (jsdom resolves rem to px in toHaveStyle)
```

That was a bug in my test, not the component: I changed the test to use px values. Then:

```
 Test Files  3 passed (3)
      Tests  69 passed (69)
```

One lint error appeared on the first pass: `react-hooks/static-components` on `<Component {...props} />` in `UiLink`. It is a false positive, because the component is the one reference the provider was given and not created during render. I suppressed it on that line with a comment explaining why.

## Files changed

- `package-lock.json`
- `packages/ui/package.json`
- `packages/ui/src/index.ts`
- `packages/ui/src/link.tsx`, `pressable.tsx`, `cx.ts`
- `packages/ui/src/components/{Avatar,Badge,Button,Card,EmptyState,Field,IconButton,Pill,Select,Skeleton,StatCard,Toggle}/*`
- `packages/ui/test/primitives.test.tsx`, `packages/ui/test/setup.ts`

## Self-review findings

- **Contrast** (I computed these):
  - `--accent-ink` on `--accent` is 8.1:1.
  - `#fff` on `--danger` is 4.51:1. `--surface` as the "white" would give 4.44:1 and fail, so danger uses literal `#fff`, bold, with a comment (see concerns).
  - The control border, `--text-muted` on `--surface`, is 5.96:1, so inputs and selects meet the 3:1 non-text rule. Using `--line` there would have been about 1.2:1.
  - A field with an error has a `--danger` border at 4.4:1, and its message is `--text` on a `--danger` bar, not red text.
  - Toggle outlines are `--text-muted` or `--text`, over 5:1.
  - `--success` is not used anywhere.
- **Focus** comes from the global `:focus-visible` ring in base.css. No component removes it.
- **Touch targets:** Button, IconButton, Toggle, Field and Select are at least 40px. Pill is 32px on desktop and 40px on phone. Avatar, Badge and Skeleton are not interactive.
- **Copy rule:** no literal text in any kit JSX. The only string literals in JSX expressions are `'99+'` (via the `MAX_SHOWN` template, no letters), `'on'`/`'off'` and other non-text attribute values.
- **Types:** the `href` branch of `Pressable` casts the button attributes to anchor attributes, once, in one place.

## Concerns

1. **Button and IconButton types with `href`.** I used the brief's signature as written: `ButtonHTMLAttributes & { href?: string }`. In the link branch, button-only attributes such as `form` and `name` would reach the `<a>`. The Button doc comment says not to use them with `href`. A discriminated union would be stricter if you want it later.
2. **Raw `#fff` in `Button.module.css`**, the danger variant's text. This is the only colour in the kit that is not a token. I did it to meet WCAG AA (4.51:1 versus 4.44:1 for `--surface`). Adding an `--on-danger` token would remove it, but that means editing `tokens.css`, `tokens.ts` and the token test, which I judged outside this task.
3. **`Field` generic.** Field and Select do not forward a `ref`, so a form cannot focus the first invalid field yet. A later task can add it if the settings forms need it.
4. **Defaults the brief left open:** `Pill` tone defaults to `accent`, `Avatar` size to 32, `Field` `rows` to 3 and `Skeleton` height to `1rem`.
5. **`lockfile`:** npm also dropped a stale `"peer": true` flag on one `@babel` entry. This is harmless.

---

# Fix round 1 (review finding plus rulings F and G)

Commit: see `git log` on `f2-shell`, subject `fix(ui): danger hover keeps AA contrast; primitives forward refs`.

## Finding (Important): danger button fails AA on hover

Cause: `Button.module.css` gave primary and danger the same `filter: brightness(0.94)` hover, and the filter dims the white text along with the fill. I computed white at 94% on the 94% dimmed `--danger` at 4.39:1, under 4.5:1.

Ruling F applied:
- New tokens `--on-danger: #ffffff` and `--danger-hover: #c92a2a` in `tokens.css` and `tokens.ts`. `--danger` is unchanged.
- The danger variant's text is `var(--on-danger)`, which replaces the literal `#fff`. There is no raw colour left in the kit's CSS.
- Danger hover changes only the background to `var(--danger-hover)`. The `filter` rule now applies to the primary variant only, and the disabled-hover overrides were split per variant so a disabled danger button keeps `--danger` on hover.
- White on `--danger-hover` is 5.46:1 (computed). White on `--danger` at rest is still 4.51:1.
- `test/tokens.test.ts`: the exact-value list gained `--on-danger` and `--danger-hover`. The existing parity test already checks `tokens.ts` against `tokens.css`, so it covers both new tokens.

## Ruling G: ref forwarding

`Button`, `IconButton`, `Toggle`, `Field` and `Select` take a `ref` prop (React 19 ref-as-prop), typed as ruled:
- `Button` and `IconButton`: `Ref<HTMLButtonElement | HTMLAnchorElement>`. It goes to the button, or to the anchor when `href` is set.
- `Toggle`: `Ref<HTMLButtonElement>`.
- `Field`: `Ref<HTMLInputElement | HTMLTextAreaElement>`. It goes to the input, or to the textarea when `multiline`.
- `Select`: `Ref<HTMLSelectElement>`.

How it flows:
- The shared `Pressable` takes `ref` explicitly and passes it to the `<button>` or the `UiLink`.
- `UiLinkProps` gained `ref?: Ref<HTMLAnchorElement>`. The default `<a>` takes it directly, and a provided adapter that spreads its props onto the router Link passes it on.
- `Pill` was not in the ruling and has no ref.

Tests added: a `refs` describe block with 4 tests in `primitives.test.tsx`. One matches the ruling (a ref passed to Button and to Field points at the rendered button and input). The other three cover the anchor for Button and IconButton with `href`, the textarea for a multiline Field (including `.focus()`), and IconButton, Toggle and Select.

## TDD evidence

RED, after adding the tests and token expectations, before any change to the source:

```
$ npx vitest run --project @roofline/ui
 × S1 tokens > has every S1 token with its exact value        (--on-danger undefined)
 × refs > reaches the IconButton, Toggle and Select elements  (Toggle ref null)
 Tests  2 failed | 71 passed (73)
$ npm run typecheck
 error TS2322 ... Property 'ref' does not exist on type ... (Field, Button, IconButton, Toggle, Select)
```

The Button and Field ref runtime tests already passed at that point, because React 19 leaves `ref` in `...rest`, which was spread onto the element by accident. Only the types failed for them. The implementation now takes `ref` explicitly instead of relying on the spread.

GREEN, after the change:

```
$ npx vitest run --project @roofline/ui
 Test Files  3 passed (3)
      Tests  73 passed (73)
$ npm run lint        -> clean
$ npm run lint:css    -> clean
$ npm run typecheck   -> clean
$ npx vitest run --project @roofline/web   (imports the kit's tokens)
 Test Files  3 passed (3)
      Tests  30 passed (30)
```

I did not re-run the full workspace suite. The change touches only `packages/ui`; the web project, which consumes it, was run as above.

## Files changed in this round

- `packages/ui/src/tokens.css`, `packages/ui/src/tokens.ts`
- `packages/ui/src/link.tsx`, `packages/ui/src/pressable.tsx`
- `packages/ui/src/components/{Button,IconButton,Toggle,Field,Select}/*.tsx`
- `packages/ui/src/components/Button/Button.module.css`
- `packages/ui/test/tokens.test.ts`, `packages/ui/test/primitives.test.tsx`

Original concerns now resolved: 2 (the raw `#fff`) and 3 (no ref on Field and Select). Concern 1 (button-only attributes reaching the anchor when `href` is set) stands.

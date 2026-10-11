# Task 4 report: Design kit layout (Window, Sheet, Dock, TopBar, Toast, focus trap)

Status: DONE (with the concerns below)
Commit: `6058276 feat(ui): window, sheet, dock, top bar, toasts and focus trap` on branch `f2-shell` (not pushed)

## What was implemented

All in `packages/ui`, exported from `src/index.ts` (components, prop types, `useFocusTrap`, `FocusTrapOptions`).

- `src/focus-trap.ts`: `useFocusTrap(ref, { active, onEscape?, initialFocus? }): void`
  - While active, a single `keydown` listener on `document` handles Tab/Shift+Tab (wrap at the first/last tabbable, pull focus back in when it is outside the container) and Esc (`onEscape`). Mouse clicks are not blocked and nothing outside is made inert.
  - On activation it remembers `document.activeElement` and focuses `initialFocus`, else the container. On deactivation/unmount it focuses the remembered element if `isConnected`, else leaves focus alone.
  - Module-level stack of active traps: only the newest handles Tab and Esc; deactivation removes it. Refinement: a trap whose container contains another trap's container is inserted *under* it (parents' effects run after children's, so a Sheet inside a Window mounted in the same render would otherwise lose to the Window).
  - Latest `onEscape` / `initialFocus` are read through `useEffectEvent`, so the trap does not restart when the callback identity changes. An Esc/Tab already `preventDefault`ed by something inside, or during IME composition, is ignored.
  - Tabbable = `a[href], button, input, select, textarea, [tabindex], [contenteditable]` minus: `:disabled` (incl. disabled fieldset), `input[type=hidden]`, `tabindex<0`, any ancestor (up to the container) with `hidden`/`inert`/`aria-hidden="true"`. No offsetWidth/offsetHeight (jsdom has no layout).
- `Window`: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` the `<h1>`, `aria-describedby` the description (only when there is one), `tabIndex={-1}` container is the initial focus, ✕ `IconButton(closeLabel)`, `onEscape: onClose`, `data-variant` (`floating` default, `page`), optional `stats` strip, scrolling body, `footer` pinned at the bottom. CSS: `width: min(90vw, 1280px); height: min(90vh, 860px)`, fixed + inset 0 + margin auto, `--radius-window`, `--shadow-window`; `page` = fixed full screen, no radius/shadow.
- `Sheet({ open, title, onClose, closeLabel, children, footer? })`: same dialog semantics and trap (`<h2>` title), renders `null` when closed. Right-side 440px panel on desktop, bottom sheet (max 85vh, rounded top) below 768px.
- `Dock({ label, items })` + `DockItem`: `<nav aria-label><ul>` of `UiLink`s; icon (aria-hidden) over an always-visible 12px label; `aria-current="page"` on current; coming-soon item has `data-state="soon"`, `title`, muted colour (`--text-muted`), a `visually-hidden` suffix span after the label, and stays a working link; `Badge` for badges (nothing at zero).
- `TopBar({ start, middle?, end? })`: `<header>` grid `1fr auto 1fr`, three always-rendered slot containers (`data-slot="start|middle|end"`), min-height 56px.
- `ToastProvider({ children, closeLabel })` + `useToast(): { show(message, tone?) }`: errors in an always-rendered `role="alert"` region, info/success in an always-rendered `role="status"` region (`aria-atomic="false"` so only the new toast is read). 6000 ms dismiss; the same message already showing is not added again (timer restarts, tone updates to the latest, so a repeat as an error moves to the alert region); each toast has a close `IconButton(closeLabel)`; timers cleared on unmount; `show` is stable; `useToast` outside a provider throws.
- `src/close-icon.tsx`: the shared ✕ SVG (no text).
- `packages/ui/package.json` + `package-lock.json`: peer range `react`/`react-dom` `^19.0.0` -> `^19.2.0`, because `useEffectEvent` needs 19.2 (installed: 19.3.0).

## TDD evidence

RED (`packages/ui/test/layout.test.tsx` written first, nothing implemented):
```
$ npx vitest run --project @roofline/ui
 Test Files  1 failed | 3 passed (4)
      Tests  45 failed | 73 passed (118)
 FAIL ... layout.test.tsx > Toast > throws a clear error when used without a provider
 AssertionError: ... "(0 , __vite_ssr_import_4__.useToast) is not a function"
```
(Every test in the new file failed because the exports did not exist.)

First GREEN attempt had 3 failures, all real findings, fixed:
1. Dock accessible name came out as "ReportsComing soon" (inline spans run together): added `{' '}` between label, hidden suffix and badge.
2. My first "skips non-tabbable controls" test assumed the trap controls *every* Tab step. It only controls the edges (the browser does the middle, and user-event does not skip `inert`/`aria-hidden` there). Rewrote it to assert what the trap owns: wrapping at the first/last *reachable* control with unreachable ones (disabled, tabindex -1, hidden, inert, aria-hidden, display:none, visibility:hidden, disabled fieldset, input hidden, `<a>` without href) on both sides.
3. A test helper compared untrimmed text.

GREEN:
```
$ npx vitest run --project @roofline/ui      (3 consecutive runs)
 Test Files  4 passed (4)
      Tests  119 passed (119)        # 46 new in layout.test.tsx
$ npm run lint        -> clean
$ npm run lint:css    -> clean
$ npm run typecheck   -> clean
$ npx vitest run      (full suite, once, before commit)
 Test Files  47 passed (47)
      Tests  2185 passed (2185)      # the known rep-visibility flake did not fire
```
A probe file with `<p>Hello</p>` in `packages/ui/src` was refused by the lint rule (and removed), so the no-literal-text rule demonstrably covers the new files.

Mutation checks (each reverted afterwards) to confirm the tests bite:
- no containment ordering -> "sheet wins when both mount together" fails
- any trap answers keys -> "Esc closes only the sheet" and "Tab stays inside the sheet" fail
- no focus restore -> opener tests (window, hook, sheet, sheet-over-window) fail
- no display/visibility filter -> "wraps at first/last reachable control" fails
- dropping the `isConnected` guard changes nothing observable (focusing a detached node is a no-op in jsdom and browsers); the guard stays because the brief says so.

Tests cover: Tab trap cycle + Shift+Tab, Esc, focus on dialog at start, return of focus to opener, labelling/description, variants, close button, stats/body/footer, outside click not blocked and nothing inert, Tab from outside pulled back in, reachable-edge wrapping, no tabbable controls, opener removed, StrictMode (one listener), hook options (initialFocus, toggling, latest onEscape, already-handled Esc), Sheet closed/open/trap/restore, Sheet over Window (opened later AND mounted together; Esc closes only the Sheet, then the Window), Dock (six items, labels visible, aria-current, soon state + accessible name, badge, zero badge, list semantics, icon hidden, router adapter, keyboard), TopBar slots, Toast (alert vs status, empty live regions at start, tone attrs, 6 s, dedupe + timer restart, separate timers, close button + stale timer, tone change moves region, stable `show`, timer cleanup, throw without provider).

## Files changed (14, +1726)

- new: `packages/ui/src/focus-trap.ts`, `packages/ui/src/close-icon.tsx`
- new: `packages/ui/src/components/{Window,Sheet,Dock,TopBar,Toast}/<Name>.tsx` and `<Name>.module.css`
- new: `packages/ui/test/layout.test.tsx`
- modified: `packages/ui/src/index.ts`, `packages/ui/package.json`, `package-lock.json` (peer range only)

I also looked at the CSS in a real browser with a throwaway Vite harness (deleted; nothing left in the repo): window centered with the map visible, body scrolls, footer pinned, page variant fills the screen at 375px, sheet is a right panel on desktop and a bottom sheet on phone, dock labels visible with muted "soon" item and badge, toasts stack.

## Self-review findings (fixed during the task)

- Title bar and footer inside the Window are `div`s, not `header`/`footer`: inside a plain `div[role=dialog]` those would map to banner/contentinfo landmarks and duplicate the TopBar's.
- Toasts first went top-right and covered the Window's ✕; moved to top-center (phone: bottom, 72px up, above a tab bar).
- `nextId` was incremented inside a `setState` updater (impure under StrictMode double-calls); moved out.
- Peer range corrected for `useEffectEvent` (above).

## Concerns / things the next tasks should know

1. **Brief's Tab-cycle wording.** The brief says "first -> close -> second -> first". The close button lives in the title bar, so in DOM order it comes before the body buttons; the test asserts the real ring: close -> first -> second -> close (and the reverse with Shift+Tab). Nothing ever lands on the opener.
2. **Extra tabbable filter.** Beyond the decided list (disabled, hidden/inert ancestors, aria-hidden, tabindex) I also exclude `display: none` and `visibility: hidden` (via `getComputedStyle`, not layout). Without it a collapsed section at the end of a window would count as "last" and Tab would leak out of the trap on the real last control. Cheap, no layout dependency.
3. **The trap only owns the edges.** Tab in the middle is the browser's. Native behaviour skips `inert`/`hidden`/`display:none` but still focuses elements inside `aria-hidden="true"` (an authoring bug anyway).
4. **Sheet inside a Window stays in the Window's layer.** A fixed element is its own stacking context, so a Sheet rendered inside `<Window>` sits at the Window's z-index (20) relative to the page; a dock/tab bar above 20 would cover its bottom. Rendering the Sheet beside the Window lifts it to 30. I did not portal it: a portal would break the "same render, inner trap wins" ordering (needs a React-ancestry context). Documented in `Sheet.tsx`.
5. **Dock and TopBar set no position or z-index.** The shell places them. Layers used by the kit: Window 20, Sheet 30, Toasts 40. For "dock stays clickable while a window is open" the shell must put the dock above 20. Also, the `page` Window variant is `fixed; inset: 0`, so on phones it covers a bottom tab bar unless the shell gives the tab bar a higher z-index or adjusts the window's bottom inset (no CSS variable hook exists yet).
6. **Footer "sticky"** is a non-scrolling flex sibling of the scrolling body (pinned for the same effect), not `position: sticky`.
7. **Toast close button sits inside the live region**, so a screen reader may read its label after the message. Acceptable for now; the alternative is restructuring so only the message text is live.
8. **Commit trailer.** I used `Co-Authored-By: Claude Opus 5.5` as instructed in the task (matches the earlier commits), although this session's model is Sonnet 5.5. Change it if you want it to be literal.
9. Toast placement (top-center desktop, bottom on phone) is my call; trivial to move in `Toast.module.css`.

---

# Fix round 1

Commit: see `git log` (`fix(ui): nested traps keep focus on the top sheet and restore to the real opener; sheets portal to body`, on top of 6058276).

## Finding fixed (Important): nested traps mounted in the same commit

Cause: the Sheet's effect (child) ran first, recorded the real opener and focused the Sheet; the Window's effect then recorded the *Sheet container* as its opener and focused itself. Result: the Window announced instead of the Sheet, and on unmount focus was never returned to the real opener.

Changes (`packages/ui/src/focus-trap.ts`, `Window.tsx`, `Sheet.tsx`):
- Ordering is now by React ancestry, not DOM containment (the Sheet is portaled, so its markup is no longer inside the Window's). `TrapScope = { parent }` is created on a trap's first render from `TrapScopeContext`; `Window` and `Sheet` wrap what they render in `<TrapScopeContext value={scope}>` (a portal keeps context). `useFocusTrap(ref, opts): void` keeps the brief's signature and reads the context; the internal `useScopedFocusTrap` (not exported from index) also returns the scope.
- On activation, a trap that finds an active trap *below it in the tree* goes under it, does **not** focus, takes over that trap's opener (the real one) and records itself as the inner trap's `outer`.
- On cleanup the inner trap focuses its `outer`'s container while that outer is still active (closing only the Sheet puts focus back in the Window), and does nothing once the outer has already ended (the outer already restored the real opener; this also fixes StrictMode's double effect run, where React cleans up parent-first and a naive version tainted the re-setup's opener). Traps with no outer restore to their own opener as before.

## Ruling H applied
1. `Sheet` renders with `createPortal(..., document.body)`. Layers documented in comments (`Window.module.css`, `Sheet.module.css`, `Sheet.tsx`, `Dock.tsx`): Window 20, dock 30, Sheet 40, toasts 50 (`Sheet.module.css` z-index 40, `Toast.module.css` z-index 50). The old "render it beside the Window" caveat is removed.
2. Page-variant Window: `bottom: var(--shell-bottom-inset, 0px)` (with `inset: 0` for the other edges), so the phone shell can reserve its tab bar.

## Tests (packages/ui/test/layout.test.tsx, +5)
- both mounting together: initial focus is on the Sheet (added to the existing key-routing test too)
- both mounting together, then unmounting together: focus returns to the real opener (also under `StrictMode`)
- both mounting together, then closing only the Sheet: focus goes into the Window; then the Window closing returns it to the real opener
- the Window gets Esc/Tab back after a Sheet that mounted with it closes
- the Sheet is portaled: its dialog's parent is `document.body`, outside the render container and outside the Window's markup

RED (new tests, old implementation via `git stash push -- packages/ui/src`):
```
$ npx vitest run --project @roofline/ui
 × Sheet > is portaled into the body, outside the markup of the window it is rendered from
 × Sheet > over a window > lets the sheet, not the window, handle Esc and Tab when both mount together
 × ... > starts on the sheet and restores to the real opener when both mount together
 × ... > starts on the sheet and restores to the real opener when both mount together under StrictMode
 × ... > returns focus into the window when only the sheet closes, then to the real opener
      Tests  5 failed | 119 passed (124)
```
GREEN:
```
$ npx vitest run --project @roofline/ui && npm run lint && npm run lint:css && npm run typecheck
      Tests  124 passed (124)      (2 consecutive runs)
 lint, lint:css, typecheck: clean
$ npx vitest run   (full suite)
 Test Files  47 passed (47)
      Tests  2190 passed (2190)
```
Mutation checks (each reverted): no ancestry ordering -> 4 fail; outer steals focus -> 4 fail; no opener takeover -> 3 fail; no "outer already ended" guard -> the StrictMode test fails.

## Notes
- The page-variant bottom inset is CSS only (CSS is not processed in the vitest project); stylelint passes. Nothing sets `--shell-bottom-inset` yet: the phone shell task must.
- A custom component that renders its own trap with `useFocusTrap` and holds other traps in its children would need the internal scope to nest correctly; today only Window and Sheet do that.

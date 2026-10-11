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


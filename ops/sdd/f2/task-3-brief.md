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


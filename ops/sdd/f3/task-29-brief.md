### Task 29: Design kit additions: Checkbox, ProgressBar, ProgressRing, FilePicker, Banner

**Base:** `f3-setup` (F2 T5 is in; nothing F3 is needed). `packages/ui` rules (F2 global constraints): string-free components (all text by props), CSS Modules plus the S1 tokens only, state on `data-*` attributes, 12px minimum type (stylelint), visible focus ring `outline: 2px solid var(--text); outline-offset: 2px`, 40px touch targets on phone, React 19 `ref` as a prop (Ruling G) on focusable elements. One folder per component: `packages/ui/src/components/<Name>/<Name>.tsx` + `<Name>.module.css` (see `Toggle`, `Field`). `Button` from the kit for every button.

**Split:**
- Builder 1: `Checkbox` and `FilePicker`.
- Builder 2: `ProgressBar` and `ProgressRing`.
- Builder 3: `Banner`, the `index.ts` exports, and `packages/ui/test/f3-components.test.tsx`.

**Files:**
- Create: `packages/ui/src/components/{Checkbox,ProgressBar,ProgressRing,FilePicker,Banner}/{<Name>.tsx,<Name>.module.css}`
- Modify: `packages/ui/src/index.ts` (append the five components and their `…Props` types, alphabetically among the existing lines)
- Test: `packages/ui/test/f3-components.test.tsx`
- Do not touch: `tokens.css`/`tokens.ts` (no new tokens; Ruling F's `--danger-hover`/`--on-danger` exist if needed), any other component.

**Interfaces:**
```ts
export type CheckboxProps = { checked: boolean; onChange(next: boolean): void; label: ReactNode; description?: string; error?: string; disabled?: boolean; ref?: Ref<HTMLInputElement> };
export type ProgressBarProps = { value: number; max: number; label: string };
export type ProgressRingProps = { done: number; total: number; label: string; size?: 24 | 32 };
export type FilePickerProps = { label: string; buttonLabel: string; dropLabel: string; accept: string; onFile(file: File): void; help?: string; error?: string; busy?: boolean };
export type BannerProps = { tone: 'info' | 'warning' | 'danger'; children: ReactNode; action?: ReactNode };
```
- **Checkbox:** a native `<input type="checkbox">` inside a `<label>` (label text after the box); `data-state="checked"|"unchecked"` on the root; `description` linked with `aria-describedby`; `error` rendered with `role="alert"` and the input gets `aria-invalid="true"` and `aria-describedby` including it; the whole label row is at least 40px tall (hit area); `disabled` passes through.
- **ProgressBar:** `role="progressbar"`, `aria-valuemin={0}`, `aria-valuenow={clamped value}`, `aria-valuemax={max}`, `aria-label={label}`; a filled bar sized `value/max` (guard `max <= 0` → 0%); bar colour `--accent` on `--surface-2`.
- **ProgressRing:** an `<svg role="img" aria-label={label}>` of `size` (default 24) px with a background circle and a progress arc (`stroke-dasharray`); `data-complete` present when `done >= total`; `--success` for the arc when complete, `--accent` otherwise (colour only, never text).
- **FilePicker:** a visually hidden `<input type="file" accept={accept}>` (class `visually-hidden`, which `base.css` defines) with `aria-label={label}`, opened by a kit `Button` (`buttonLabel`, `busy`); a drop zone showing `dropLabel` that sets `data-state="over"` on `dragenter`/`dragover` (with `preventDefault`) and back to `idle` on `dragleave`/`drop`; `onFile` with the first file of `change` or `drop`; the input is reset after each pick so the same file can be picked twice; `help`/`error` like `Field` (error `role="alert"`).
- **Banner:** `role="alert"` for `danger`, `role="status"` otherwise; `data-tone={tone}`; full width, `min-width: 0`, text wraps (`overflow-wrap: anywhere`), the `action` slot wraps under the text below 768px; no horizontal overflow at 375px. Tones: `info` on `--surface-2`, `warning` with an `--accent` left border, `danger` with a `--danger` left border — text always `--text` (AA).

**Tests (`f3-components.test.tsx`)** — Testing Library + `userEvent`:
- clicking the Checkbox label calls `onChange(true)`; with `error` the input has `aria-invalid="true"` and the error has `role="alert"`; `data-state` follows `checked`.
- `<ProgressBar value={40} max={100} label="Importing" />` → `getByRole('progressbar', { name: 'Importing' })` has `aria-valuenow="40"`.
- ProgressRing: `getByRole('img', { name: '2 of 5 setup steps done' })`; `data-complete` absent at 2/5, present at 5/5.
- FilePicker: `userEvent.upload(getByLabelText(label), file)` calls `onFile(file)`; `fireEvent.dragEnter(zone)` sets `data-state="over"`, `fireEvent.drop(zone, { dataTransfer: { files: [file] } })` calls `onFile` and resets it.
- Banner: `danger` → `getByRole('alert')`; `warning` → `getByRole('status')`; the `action` renders.

**Verify notes:**
- Runs locally (no database): `npx vitest run --project @roofline/ui && npm run lint && npm run lint:css && npm run typecheck`.
- Commit: `feat(ui): checkbox, progress bar and ring, file picker, banner`.

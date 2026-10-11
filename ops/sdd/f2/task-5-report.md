# Task 5 report: ReviewSteps (the R2 review component)

Status: DONE_WITH_CONCERNS (kit work and its checks are green; the database-backed suites could not be run on this machine, see Concerns).

Commit: `f3b43ad feat(ui): ReviewSteps, the one review screen every agent uses` on branch `f2-shell`.

## What I implemented

- `packages/ui/src/components/ReviewSteps/summarize.ts`
  - Types `ReviewStep` and `ApprovalSummary`, and `summarizeApproval(steps)`.
  - Counts only steps that are `open` and `enabled`. Not `canApprove` goes to `ownerSteps`. Otherwise `count`, and a `spend` step adds `preview.maxSpendCents ?? 0` to `maxSpendCents`.
- `packages/ui/src/components/ReviewSteps/ReviewSteps.tsx`
  - Types `ReviewStepsCopy` and `ReviewStepsProps` (the brief's signatures, verbatim) and the `ReviewSteps` component.
  - `<ol role="list">` of `<li data-state="on|off" data-status={status}>` rows.
  - `import type` only from `@roofline/shared`, so the kit pulls no zod or libphonenumber at runtime.
  - Review mode rows:
    - Toggle (`labelHidden`, name `switchLabel(title)`), disabled when `!open || pending || !canApprove`.
    - Bold title (`<strong>`).
    - Status label only when the step is no longer `open` (the Toggle is still rendered, disabled).
    - Preview: `messageSample` bubble with `data-wrap="anywhere"`; a facts list with `recipients()`, `sendTime()` and `spend()` (each shown when its value is present, so a recipient count of 0 still shows); `lines`.
    - `ownerApprovesSpending` on a spend step without `canApprove`.
    - Edit as `Button variant="ghost"` when `editable && open && canApprove` and `onEdit` is passed.
  - Footer (review mode only):
    - Note: `footerNoteSpend` if any spend step exists, else `footerNote`.
    - `Not now` (ghost).
    - `Approve` (`primary`, `lg`, `busy={approving}`), labelled `approveButton(summary)`; `nothingOn` and disabled when `count + ownerSteps === 0`.
  - Progress mode: no toggles and no footer. Each row shows `stepStatus(status)` (or `waitingForOwner` for `awaiting_owner`), then `resultLines(result)`, then `errorPlain`.
  - Retry (ghost) is keyed on status: `failed` or `needs_attention`, and `canApprove`, and `onRetry` given. An `errorPlain` on its own never shows it.
- `packages/ui/src/components/ReviewSteps/ReviewSteps.module.css`
  - Bubble: `[data-wrap="anywhere"]` gets `overflow-wrap: anywhere; white-space: pre-wrap`.
  - Footer: `position: sticky; bottom: 0; z-index: 1`.
  - Tokens only for colour. All font sizes are `var(--font-size-*)`.
  - Switched-off rows are greyed with `--surface-2` and `--text-muted` instead of opacity, so the text keeps AA contrast.
  - Error text stays `--text` with a `--danger` bar, because `--danger` as text fails AA on `--surface`.
- `packages/ui/src/index.ts`: exports `ReviewSteps`, `summarizeApproval` and the types `ReviewStep`, `ApprovalSummary`, `ReviewStepsCopy`, `ReviewStepsProps`.
- `packages/ui/package.json` and `package-lock.json`: `"dependencies": { "@roofline/shared": "^0.0.0" }` (lock regenerated with `--package-lock-only --offline`, 3 lines).

## Tests

Files: `packages/ui/test/summarize.test.ts` (6 tests), `packages/ui/test/review-steps.test.tsx` (24 tests), and a shared helper `packages/ui/test/review-fixtures.ts` (step factories `msg`, `internal`, `spend`, plus a test `copy` whose strings show their inputs).

The brief's cases are all there:
- summarize: the four expectations from the brief verbatim, plus spend-only-for-counted-steps, a missing amount, and a message step's amount ignored.
- component: Approve label from the summary; grey and recount on toggle; office user sees `ownerApprovesSpending` with a disabled toggle; Retry only for `failed` and `needs_attention` (a `running` step with `errorPlain` has none, `failed` calls `onRetry(id)`); Approve disabled with `nothingOn`; the 400-character bubble.
- Extras I added:
  - `<ol>` and `<strong>` structure.
  - Re-enabling a step.
  - An office user whose only step is the owner approval keeps Approve enabled.
  - Preview fields, and a recipient count of 0.
  - Edit gating, and no Edit without `onEdit`.
  - A non-open step shows the status and a disabled switch.
  - `pendingStepIds`.
  - Footer note choice.
  - Footer buttons and variants.
  - Busy Approve does not fire.
  - Progress mode: no footer or switches, status then results then error in order, `waitingForOwner`, Retry hidden without `canApprove`, no Edit.
- The wrap test asserts `data-wrap="anywhere"` on the bubble and also reads the CSS file and checks the `[data-wrap="anywhere"]` rule really holds `overflow-wrap: anywhere` and `white-space: pre-wrap`, so the attribute and the stylesheet cannot drift apart. (jsdom does not apply module CSS, so this is the reliable check.)

### TDD evidence

RED (before any implementation), `npx vitest run --project @roofline/ui`:
```
 FAIL  |@roofline/ui| test/summarize.test.ts
Error: Failed to resolve import "../src/components/ReviewSteps/summarize.ts" ... Does the file exist?
 FAIL  |@roofline/ui| test/review-steps.test.tsx > ... (all 24)
Error: Element type is invalid: expected a string ... but got: undefined.
 Test Files  2 failed | 4 passed (6)
      Tests  24 failed | 124 passed (148)
```

GREEN (after implementing; one test-only fix on the way: the CSS-reading test needed `import.meta.dirname` because jsdom's `URL` is not a `file:` URL):
```
npx vitest run --project @roofline/ui
 Test Files  6 passed (6)
      Tests  154 passed (154)
```

Other checks, all clean: `npm run lint`, `npm run lint:css`, `npm run typecheck` (`tsc -b`).

### Full suite

- Non-database projects (`ui`, `web`, `shared`, `send-gate`, `worker`): 733 of 734 pass. The 1 failure is `packages/send-gate/test/inbound.test.ts` "a long run of courtesy words is linear", a 5000 ms timing test. It fails only because the machine load average is 100 to 300 right now. It passes (306/306) when rerun with `--testTimeout=60000`. Unrelated to this task.
- Database-backed projects (`@roofline/db`, `@roofline/api`): could NOT be verified, see Concerns.

## Files changed

- `packages/ui/src/components/ReviewSteps/ReviewSteps.tsx` (new)
- `packages/ui/src/components/ReviewSteps/ReviewSteps.module.css` (new)
- `packages/ui/src/components/ReviewSteps/summarize.ts` (new)
- `packages/ui/src/index.ts`
- `packages/ui/package.json`
- `package-lock.json`
- `packages/ui/test/summarize.test.ts` (new)
- `packages/ui/test/review-steps.test.tsx` (new)
- `packages/ui/test/review-fixtures.ts` (new, shared test helper; not in the brief's file list)

## Self-review

- Brief coverage: every bullet checked against the code. The ordering, variants and sizes, `data-*` attributes, and the exports (including the four types) match.
- Lint boundary: no letter-containing literal text in the kit's JSX. `@roofline/shared` is imported with `import type` only.
- Accessibility:
  - Toggles keep their accessible name (`labelHidden`).
  - Edit and Retry stay named exactly `copy.edit` and `copy.retry` and point at the row title with `aria-describedby`, so a screen reader hears which step they belong to without changing the button name.
  - `role="list"` on the `<ol>` keeps list semantics under `list-style: none`.
  - Touch targets are at least 40px (Toggle and Button minimums).
  - Status never rests on colour: the dot repeats the words.
- Layering: the only z-index added is `1` on the sticky footer.
- Nothing is imported from `@roofline/db`, `@roofline/send-gate` or `@roofline/api`, and nothing outside the kit imports anything new.

## Judgement calls (brief was silent)

- Preview content (bubble, facts, lines) still shows in progress mode, above the status, results and error. The brief's "Rows, in order" list reads as the full row.
- In progress mode the `awaiting_owner` status label is `waitingForOwner` in place of `stepStatus('awaiting_owner')`. Showing both would read as contradictory ("Waiting for your OK" next to "Waiting for the owner").
- `ownerApprovesSpending` shows in review mode only. In progress mode the `waitingForOwner` status already says it.
- Retry shows in progress mode only (the brief lists it under Progress), and only when `onRetry` is passed.
- `Not now` is disabled while `approving`, so the screen cannot be dismissed mid-request. Easy to drop if Task 14 wants it live.
- "Any spend step exists" for the footer note is read literally: any spend step in `steps`, switched on or not, open or not.

## Concerns

1. Database suites unverified. `@roofline/db` and `@roofline/api` need the Postgres testcontainer, an amd64 image under emulation. The Docker VM (7.75 GiB) is saturated by about 10 other emulated Postgres containers from the parallel worktrees (`RooflineWork/wt/t6`, `t7`, `t8`) and machine load is 100 to 300.
   - First full `npx vitest run` (before commit) finished with `5 failed | 44 passed` files, `79 failed | 2102 passed | 39 skipped` tests, and `Connection terminated unexpectedly` errors from `packages/db/test/rls.test.ts`. I only kept the last 30 lines of that run, so I cannot name the five files.
   - Three further attempts: two died in global setup with `Health check not healthy after 180000ms`. The third started a container, then almost every API test failed with `Failed query: begin/rollback` (container gone or starved); I killed it.
   - This change cannot touch those suites: no backend package imports `@roofline/ui` (grep confirms), and the only non-UI edits are one `dependencies` entry in `packages/ui/package.json` and the matching 3 lines in `package-lock.json`.
   - The known `rep-visibility.test.ts:400` flake was not isolated. Please rerun `npx vitest run --project @roofline/db --project @roofline/api` when the Docker host is quiet.
2. No visual check. I did not render the component in a browser. The CSS passes stylelint and the logic is covered by tests, but the sticky footer's behaviour inside the Window body, and the overall look, are unverified until Task 14 mounts it.
3. `review-fixtures.ts` is an extra shared test file (not in the brief), added so the two test files do not duplicate the step factories.

---

## Lead review and finalize (Sonnet lead, worktree `RooflineWork/wt/t5`, branch `f2-t5`)

Built by: package `packages/ui` (the ReviewSteps component, `summarize.ts`, CSS module, exports, tests and fixtures) plus one `dependencies` entry in `packages/ui/package.json` and its 3 lines in `package-lock.json`. No other package was touched. Commit under review: `f3b43ad`. (The builder's section above says branch `f2-shell`; the task worktree branch is `f2-t5`, same commit.)

### Review round 1

- Result: verify passed, 0 findings.
- Lead read-through of `summarize.ts` and `ReviewSteps.tsx` against the brief and the controller rulings:
  - `summarizeApproval` skips steps that are not `open` or not `enabled`, sends not-`canApprove` steps to `ownerSteps`, and adds `preview.maxSpendCents ?? 0` only for counted `spend` steps. Matches the brief's four expectations.
  - Rows are an `<ol>` of `<li data-state data-status>`. The bubble carries `data-wrap="anywhere"`, and the CSS rule for it holds `overflow-wrap: anywhere` and `white-space: pre-wrap` (a test reads the stylesheet, since jsdom does not apply module CSS).
  - Toggle disabled on `!open || pending || !canApprove`. A step that is no longer open shows its status label with a disabled toggle.
  - Edit is a ghost Button gated on `editable && open && canApprove`. Retry is keyed on status (`failed` or `needs_attention`) plus `canApprove`, never on `errorPlain`.
  - Footer exists in review mode only, sticky with `z-index: 1`. Approve is primary, `lg`, `busy={approving}`, labelled `approveButton(summary)` or `nothingOn` and disabled when `count + ownerSteps === 0`. Progress mode has no footer and no toggles.
  - Types are imported from `@roofline/shared` with `import type` only. No literal text in JSX. No raw `<button>`. No import from `@roofline/db`, `@roofline/send-gate` or `@roofline/api`.
- Outcome: no fixes needed. Nothing amended, nothing rejected. No new commit was made, so HEAD stays `f3b43ad`.

### Minors (not fixed, no action required)

- Builder's concern 1 stands: the database-backed suites (`@roofline/db`, `@roofline/api`) were not verified on this task. This change cannot reach them (no backend package imports `@roofline/ui`; the only non-UI edits are one dependency line and its lockfile lines). Per the house rules they were not run in this finalize step; if wanted, run them through `~/RooflineWork/bin/dbtest`.
- Builder's concern 2 stands: no visual check of the sticky footer inside the Window body until Task 14 mounts the component.
- `key={index}` on the preview and result line lists is fine because the lists are static per render and have no state.

### Finalize verify

Command, from the worktree root: `npx vitest run --project @roofline/ui && npm run lint && npm run lint:css && npm run typecheck`. Exit 0.

```
 Test Files  6 passed (6)
      Tests  154 passed (154)
   Duration  14.30s

> eslint .                      (no output, clean)
> stylelint "packages/ui/src/**/*.css" "apps/web/src/**/*.css" --allow-empty-input   (clean)
> tsc -b                        (clean)
```

`git status --short` after the run: empty. Only ignored `*.tsbuildinfo` files were produced.

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


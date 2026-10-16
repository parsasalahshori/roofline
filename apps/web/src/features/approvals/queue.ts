import type { ApprovalFact } from '@roofline/ui';
import type { StepView, TaskView } from '../../api/types.ts';
import { approvals } from '../../copy/approvals.ts';
import { review } from '../../copy/review.ts';
import { isOpen } from './toReviewStep.ts';
import { kitFor } from './steps/index.ts';

/*
 * What the approvals queue reads off a plan. Everything here comes from fields the list already carries (the steps,
 * their previews, the end time); a fact the plan does not hold is left out, never guessed. The list's steps carry no
 * payload (a batch can hold thousands of customer ids), so nothing here looks inside one.
 */

/** The steps this person has a decision on. */
export function openSteps(task: TaskView): StepView[] {
  return task.steps.filter((step) => isOpen(step, task));
}

/**
 * Whether Approve can be a yes right on the queue: one step is waiting, it is switched on and this person may approve
 * it. That is the same yes the review screen sends with nothing changed. A plan with several steps to decide, or one
 * this person cannot finish (the spend waits for the owner), is decided on the review screen.
 */
export function quickApprovable(task: TaskView): boolean {
  const open = openSteps(task);
  const only = open[0];
  return !task.expired && open.length === 1 && only !== undefined && only.enabled && only.canApprove;
}

/** The step types whose recipients are texts, and the ones whose recipients are emails. */
const TEXT_STEPS: ReadonlySet<string> = new Set(['send_sms_batch', 'demo_message', 'send_personal_texts']);
const EMAIL_STEPS: ReadonlySet<string> = new Set(['send_email_batch']);

function recipientsWords(step: StepView, count: number): string {
  if (TEXT_STEPS.has(step.type)) return approvals.textsValue(count);
  if (EMAIL_STEPS.has(step.type)) return approvals.emailsValue(count);
  return approvals.customersValue(count);
}

/**
 * The facts under a card's title. Who a plan reaches is locked (the review screen cannot change a recipient); what it
 * costs is locked unless a spend step's own Edit lets the maximum come down.
 */
export function cardFacts(task: TaskView): ApprovalFact[] {
  const open = openSteps(task);
  const facts: ApprovalFact[] = [];

  if (open.length > 1) {
    facts.push({ label: approvals.factSteps, value: approvals.stepsValue(open.length), mono: true });
  }

  const reached = open.flatMap((step) =>
    step.preview.recipientCount === undefined ? [] : [recipientsWords(step, step.preview.recipientCount)],
  );
  if (reached.length > 0) {
    facts.push({ label: approvals.factRecipients, value: reached.join(' · '), mono: true, locked: true });
  }

  const sends = open.find((step) => step.preview.sendTime)?.preview.sendTime;
  if (sends) facts.push({ label: approvals.factSends, value: sends });

  const spending = open.filter((step) => step.approvalClass === 'spend' && step.preview.maxSpendCents !== undefined);
  const cents = spending.reduce((sum, step) => sum + (step.preview.maxSpendCents ?? 0), 0);
  if (cents > 0) {
    facts.push({
      label: approvals.factCost,
      value: review.spend(cents),
      mono: true,
      locked: !spending.some((step) => kitFor(step) !== undefined),
    });
  }

  return facts;
}

/** The plans newest first. The server sends them that way already; the copy is sorted anyway, so a new plan never sinks. */
export function newestFirst(tasks: readonly TaskView[]): TaskView[] {
  return [...tasks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

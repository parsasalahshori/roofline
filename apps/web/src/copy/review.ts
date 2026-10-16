import type { StepResult } from '@roofline/shared';
import type { ApprovalSummary, ReviewStepsCopy } from '@roofline/ui';
import { stepStatusLabel } from './status.ts';

const wholeDollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const exactDollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Whole dollars when the amount is whole, with its cents when it is not, so a step's $148.50 and the total next to it add up. */
const dollars = {
  format: (amount: number): string => (Number.isInteger(amount) ? wholeDollars : exactDollars).format(amount),
};

/** When a plan was drafted: a short date and a clock time, in the browser's own time zone. */
const draftedAt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** When a plan ends: a weekday, a short date and a clock time. */
const endsAt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const stepWord = (n: number) => (n === 1 ? 'step' : 'steps');

/** The word after each count a step reports, singular and plural. A key not listed here is not shown. */
const RESULT_WORDS: Readonly<Record<string, readonly [singular: string, plural: string]>> = {
  sent: ['sent', 'sent'],
  delivered: ['delivered', 'delivered'],
  failed: ["couldn't send", "couldn't send"],
  blocked: ['held back', 'held back'],
  replies: ['reply', 'replies'],
  booked: ['inspection booked', 'inspections booked'],
};

/** The review screen's words (ReviewSteps takes all of its text from here) and the sheets that open over it. */
export const review = {
  // --- ReviewStepsCopy (the kit's contract) ---
  approveButton: (s: ApprovalSummary): string => {
    const { count, maxSpendCents, ownerSteps } = s;
    if (ownerSteps > 0 && count > 0) {
      return `Approve ${count} ${stepWord(count)} · send ${ownerSteps === 1 ? 'ad' : `${ownerSteps} steps`} to owner`;
    }
    if (ownerSteps > 0 && count === 0) return 'Send to owner';
    if (maxSpendCents > 0) return `Approve ${count} ${stepWord(count)} · up to ${dollars.format(maxSpendCents / 100)}`;
    return `Approve ${count} ${stepWord(count)}`;
  },
  nothingOn: 'Turn on a step to approve',
  notNow: 'Not now',
  footerNoteSpend: 'Ad spend comes from your connected ad accounts.',
  footerNote: 'Nothing goes out until you approve.',
  ownerApprovesSpending: 'Your owner approves spending',
  waitingForOwner: 'Waiting for owner',
  edit: 'Edit',
  retry: 'Try again',
  /** The switch is named by the step it turns on or off. */
  switchLabel: (title: string): string => title,
  recipients: (count: number): string => `${count} ${count === 1 ? 'customer' : 'customers'}`,
  sendTime: (when: string): string => `Sends ${when} · quiet hours respected`,
  spend: (cents: number): string => `Up to ${dollars.format(cents / 100)}`,
  stepStatus: stepStatusLabel,
  resultLines: (result: StepResult): string[] => {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(result)) {
      // A nested group of counts is not a line of its own; only a plain count with a known word is.
      if (typeof value !== 'number' || !Object.hasOwn(RESULT_WORDS, key)) continue;
      const words = RESULT_WORDS[key];
      if (words) lines.push(`${value} ${words[value === 1 ? 0 : 1]}`);
    }
    return lines;
  },

  // --- The rest of the screen ---
  /** Shown with the placeholder bars while the plan loads. */
  loading: 'Loading this plan…',
  expiredTitle: 'This plan expired',
  expiredBody: 'Nobody answered in time, so nothing was sent. Run it again to draft a fresh plan.',
  runAgain: 'Run it again',
  /** The breadcrumb's last item while the plan's own title is still loading. */
  crumbFallback: 'Plan',
  /** The two panels beside the steps: the facts of the plan, and what each step looks like. */
  /** The name of a step whose plan did not keep one: "Step 2". */
  stepFallback: (position: number): string => `Step ${position}`,
  stepsTitle: 'Steps',
  /** The count beside the steps' title: how many are switched on. */
  stepsOn: (on: number, total: number): string => `${on} of ${total} on`,
  aboutTitle: 'About this plan',
  detailsTitle: 'Step details',
  statAgent: 'Agent',
  statDrafted: 'Drafted',
  statExpires: 'Expires',
  statSaved: 'Time saved',
  /** The time saved, as an estimate: "about 31 hours (estimate)". */
  saved: (hours: string): string => `${hours} (estimate)`,
  /** The name of the bar that holds the decision. */
  barLabel: 'Your decision',
  /** When the plan was drafted, from the ISO time the server sent, in the browser's own time zone. */
  drafted: (iso: string): string => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : draftedAt.format(date);
  },
  /** When the plan ends: a weekday, a date and a clock time, in the browser's own time zone. */
  expiresAt: (iso: string): string => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : endsAt.format(date);
  },

  // --- The edit sheet ---
  editTitle: 'Edit this step',
  /** The label of the text field: the message that goes out. */
  messageLabel: 'Message',
  save: 'Save',
  cancel: 'Cancel',

  // --- The "Not now" sheet (its confirm button reads `notNow`) ---
  notNowTitle: 'Set this plan aside?',
  reasonLabel: 'Why not? (optional)',
  reasonHelp: 'Only your team sees this. Up to 500 characters.',
} as const satisfies ReviewStepsCopy & Record<string, unknown>;

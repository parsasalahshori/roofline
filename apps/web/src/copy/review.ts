import type { StepResult } from '@roofline/shared';
import type { ApprovalSummary, ReviewStepsCopy } from '@roofline/ui';
import { stepStatusLabel } from './status.ts';

/** Whole dollars, as the screen shows every amount. */
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** When a plan was drafted: a short date and a clock time, in the browser's own time zone. */
const draftedAt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

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
  runAgain: 'Run it again',
  /** The window's stat strip: the names above the agent, the status and the time. */
  statAgent: 'Agent',
  statStatus: 'Status',
  statDrafted: 'Drafted',
  /** When the plan was drafted, from the ISO time the server sent, in the browser's own time zone. */
  drafted: (iso: string): string => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : draftedAt.format(date);
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

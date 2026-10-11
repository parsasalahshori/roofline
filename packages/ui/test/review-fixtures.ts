import type { ReviewStep, ReviewStepsCopy } from '../src/index.ts';

/** A step as the review screen gets it: open, switched on, and the caller can approve it. */
function base(overrides: Partial<ReviewStep>): ReviewStep {
  return {
    id: 'step',
    title: 'Step',
    approvalClass: 'internal',
    status: 'awaiting_owner',
    enabled: true,
    canApprove: true,
    open: true,
    preview: { title: 'Step', lines: [] },
    result: null,
    errorPlain: null,
    editable: false,
    ...overrides,
  };
}

export function msg(overrides: Partial<ReviewStep> = {}): ReviewStep {
  return base({
    id: 'msg',
    title: 'Text customers',
    approvalClass: 'message',
    editable: true,
    preview: {
      title: 'Text customers',
      lines: ['From the shop number'],
      messageSample: 'Hi Dana, we are in your area this week.',
      recipientCount: 31,
      sendTime: 'Tomorrow at 9 am',
    },
    ...overrides,
  });
}

export function internal(overrides: Partial<ReviewStep> = {}): ReviewStep {
  return base({
    id: 'int',
    title: 'Plan the route',
    approvalClass: 'internal',
    preview: { title: 'Plan the route', lines: ['12 doors, 3 hours'] },
    ...overrides,
  });
}

export function spend(cents: number, overrides: Partial<ReviewStep> = {}): ReviewStep {
  return base({
    id: 'spend',
    title: 'Run the ad',
    approvalClass: 'spend',
    preview: { title: 'Run the ad', lines: ['Neighbourhood ad'], maxSpendCents: cents },
    ...overrides,
  });
}

/** Test strings that show their inputs, so a test can tell which function produced which text. */
export const copy: ReviewStepsCopy = {
  approveButton: (s) => `Approve ${s.count} spend ${s.maxSpendCents} owner ${s.ownerSteps}`,
  nothingOn: 'Nothing is switched on',
  notNow: 'Not now',
  footerNoteSpend: 'Note with spending',
  footerNote: 'Note without spending',
  ownerApprovesSpending: 'The owner approves spending',
  waitingForOwner: 'Waiting for the owner',
  edit: 'Edit',
  retry: 'Retry',
  switchLabel: (title) => `Switch ${title}`,
  recipients: (count) => `${count} people`,
  sendTime: (when) => `Sends ${when}`,
  spend: (cents) => `Up to ${cents} cents`,
  stepStatus: (status) => `Status ${status}`,
  resultLines: (result) =>
    Object.entries(result).map(([name, value]) => (typeof value === 'number' ? `${name} ${value}` : `${name} grouped`)),
};

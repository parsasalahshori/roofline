/** The approvals list, and what the review screen says when a plan is set aside. */
export const approvals = {
  /** The toast after "Not now" went through. */
  declined: "Okay, we've set this plan aside.",
  emptyTitle: 'Nothing needs your OK.',
  repTitle: 'Approvals are for owners and office staff.',
  /** Replaces the status on a list card whose plan ran out of time. */
  expired: 'Expired',
  /** The accessible name of the list of plans. */
  listLabel: 'Plans waiting for your OK',
} as const;

import type { AddOnUnit, ProposalStatus, Tier } from '@roofline/shared';

/** Whole dollars, as the screen shows every amount. */
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/**
 * The proposal screen's words (E1 Task 17). Package C (Task 17 plan) may ADD keys; nobody renames or removes one.
 */
export const proposals = {
  // --- loading and errors ---
  pageTitle: 'Proposal',
  errorTag: "Couldn't load",
  loadFailed: "We couldn't open this proposal. Try again.",
  retry: 'Try again',
  notFound: "We couldn't find this proposal.",
  backToJobs: 'Back to jobs',

  // --- header ---
  title: (number: string): string => `Proposal ${number}`,
  customerLine: (name: string, address: string): string => `${name} · ${address}`,
  validUntil: (date: string): string => `Good until ${date}`,
  /** Labels every instant number and every price derived from one (master 9.2). */
  estimateLabel: 'Estimate',
  basisExactNote: 'Based on an exact report',
  money: (cents: number): string => dollars.format(cents / 100),
  monthly: (cents: number): string => `${dollars.format(cents / 100)}/month`,

  // --- status ---
  statusLabel: {
    draft: 'Draft',
    ready: 'Ready to send',
    sent: 'Sent',
    viewed: 'Opened',
    signed: 'Signed',
    declined: 'Declined',
    expired: 'Expired',
    replaced: 'Replaced',
  } satisfies Record<ProposalStatus, string>,
  statusLabelFor: (status: ProposalStatus): string => proposals.statusLabel[status],
  /** Shown above a proposal that cannot be edited any more. */
  readOnlyNote: 'This proposal was sent. Make a revised proposal to change it.',
  /** Banner text by status for a proposal that cannot be edited. */
  readyNote: 'This proposal is waiting for your OK before it goes out.',
  waitingForOk: 'Waiting for your OK',
  signedNote: 'This proposal is signed. Make a new proposal for more work.',
  declinedNote: 'The customer said not right now. Make a revised proposal to try again.',
  expiredNote: 'This proposal has expired. Make a revised proposal to send it again.',
  noteFor: (status: ProposalStatus): string => {
    switch (status) {
      case 'ready':
        return proposals.readyNote;
      case 'signed':
        return proposals.signedNote;
      case 'declined':
        return proposals.declinedNote;
      case 'expired':
        return proposals.expiredNote;
      default:
        return proposals.readOnlyNote;
    }
  },
  signedLine: (name: string, when: string): string => `Signed by ${name} · ${when}`,
  declinedLine: (when: string): string => `Declined · ${when}`,
  declinedReason: (reason: string): string => `Reason: ${reason}`,
  replacedNote: 'A newer proposal replaced this one.',
  openReplacement: 'Open the newer proposal',

  // --- events ---
  eventsNone: 'Not opened yet',
  /** "Opened 3 times · last today 7:12 PM". `last` comes from formatLastOpened in features/proposals/format.ts. */
  eventsLine: (count: number, last: string): string => `Opened ${count} ${count === 1 ? 'time' : 'times'} · last ${last}`,
  sentOn: (when: string): string => `Sent ${when}`,
  /** Words for a date label. `today` and `yesterday` are followed by a clock time. */
  today: 'today',
  yesterday: 'yesterday',

  // --- message preview ---
  messageHeading: 'Text message',
  messageLabel: 'What the customer gets by text',
  messageHelp: 'Keep {link} in the message so the customer can open the proposal.',

  // --- actions ---
  send: 'Send',
  sendFailed: "We couldn't start the send. Try again.",
  copyLink: 'Copy link',
  linkCopied: 'Link copied',
  copyFailed: "We couldn't copy the link. Try again.",
  downloadPdf: 'Download PDF',
  makeRevised: 'Make a revised proposal',
  reviseFailed: "We couldn't make a revised proposal. Try again.",
  saveFailed: "We couldn't save your change. Try again.",

  // --- the options as rows and, on a phone, tabs ---
  tiersLabel: 'Options',
  recommended: 'Recommended',
  /** On the option the customer signed, so the owner sees which of the three it was. */
  optionSigned: 'Signed',
  optionLeftOut: 'Left out',
  /** The one line under an option's name: what it is made of and the waste it allows for. */
  specLine: (material: string, wastePercent: number): string => `${material} · ${wastePercent}% waste`,
  activityHeading: 'Activity',

  // --- option cards ---
  optionHeading: (tier: Tier): string => proposals.tierName[tier],
  tierName: { good: 'Good', better: 'Better', best: 'Best' } satisfies Record<Tier, string>,
  optionOn: 'Include this option',
  fieldName: 'Option name',
  fieldMaterial: 'Material',
  fieldWaste: 'Waste (percent)',
  fieldMarkup: 'Markup (percent)',
  totalLabel: 'Total',
  lineItem: 'Item',
  lineAmount: 'Amount',
  includes: 'Includes',
  linesHeading: 'Price lines',
  pricesUnavailable: 'Live prices are not available to you. The saved total is shown.',

  // --- add-ons ---
  addOnsHeading: 'Add-ons',
  addOnsNone: 'No add-ons',
  addOnAdd: 'Add an add-on',
  addOnRemove: (name: string): string => `Remove ${name}`,
  addOnName: 'Add-on name',
  addOnUnit: 'Charged',
  addOnRate: 'Rate (dollars)',
  addOnTaxable: 'Taxable',
  addOnNewName: 'New add-on',
  addOnUnitLabel: {
    per_square: 'Per square',
    per_edge_ft: 'Per foot of edge',
    per_ridge_ft: 'Per foot of ridge',
    per_valley_ft: 'Per foot of valley',
    per_job: 'Once per job',
  } satisfies Record<AddOnUnit, string>,
} as const;

import { CONSENT_TEXT_V1, ESTIMATE_CLAUSE_V1 } from '@roofline/shared';

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** Whole dollars from integer cents: 1425000 gives "$14,250". */
export const money = (cents: number): string => dollars.format(cents / 100);

/** The public proposal page a homeowner opens, and the electronic signing on it. */
export const homeowner = {
  loading: 'Loading your proposal',
  pageTitle: 'Your proposal',
  greeting: (firstName: string | null): string => (firstName ? `Hi ${firstName}, here is your proposal` : 'Here is your proposal'),
  forAddress: (address: string): string => `For ${address}`,
  /** The small line over what an option is, on the sign sheet and the signed card: "Roof · Better". */
  optionKicker: (tier: string): string => `Roof · ${tier}`,
  /** A plain date, no clock and no pressure: the price is simply good until then. */
  priceGoodUntil: (date: string): string => `Price good until ${date}.`,
  chooseOne: 'Pick the option that fits you best.',
  mostPopular: 'Most popular',
  estimateLabel: 'Estimate',
  includedHeading: "What's included",
  tierLabel: { good: 'Good', better: 'Better', best: 'Best' } as const,
  allIn: 'All-in. No add-ons later.',
  // The financing line: only numbers the proposal carries (monthly, APR, number of payments); the total of the payments is their product.
  financingMonthly: (monthly: string): string => `or about ${monthly}/month`,
  financingApr: (aprPercent: string): string => `${aprPercent}% APR`,
  financingPayments: (months: number): string => `${months} payments`,
  financingTotal: (total: string): string => `total ${total}`,
  financingNote: 'Estimate. Financing is a separate approval.',
  // The roof facts card: each fact only when the company's data has it.
  roofFacts: 'Your roof',
  roofLabel: 'Roof',
  squares: (squares: number): string => `${squares.toLocaleString('en-US', { maximumFractionDigits: 1 })} sq`,
  pitchLabel: 'Pitch',
  pitch: (x12: number): string => `${x12.toLocaleString('en-US', { maximumFractionDigits: 1 })}/12`,
  hailLabel: 'Hail',
  hail: (inches: number): string => `${inches.toLocaleString('en-US', { maximumFractionDigits: 2 })} in`,
  photos: (count: number): string => `${count.toLocaleString('en-US')} ${count === 1 ? 'photo' : 'photos'} from your inspection`,
  /** The tab title of the choose step and the button that confirms it: "Choose Better · $14,250". */
  chooseOption: (tier: string, total: string): string => `Choose ${tier} · ${total}`,
  optionSelected: 'Chosen',
  signAndAccept: (cents: number): string => `Sign and accept ${money(cents)}`,
  declineLink: 'Not right now',
  callUs: (company: string): string => `Call ${company}`,
  // Signing: three steps (Choose is done by the time the sheet opens), what you are signing, how it is paid, then the signature
  signTitle: 'Sign your proposal',
  stepsLabel: 'Steps',
  stepChoose: 'Choose',
  stepSign: 'Sign',
  stepDone: 'Done',
  /** A read-only summary of the money (the API has no payment choice): the heading does not ask the homeowner to pick. */
  howYouPay: "What you'll pay",
  payTotal: 'Total',
  payMonthly: 'Or monthly (estimate)',
  payMonthlyAmount: (monthly: string): string => `${monthly}/mo`,
  payMonthlyTerms: (aprPercent: string, months: number): string => `${aprPercent}% APR · ${months} payments`,
  financingSeparate: 'Financing is a separate approval. Signing does not apply for credit.',
  consentText: CONSENT_TEXT_V1,
  estimateClause: ESTIMATE_CLAUSE_V1,
  nameLabel: 'Your full name',
  nameHelp: 'Typing your name counts as your signature.',
  drawHeading: 'Draw your signature (optional)',
  drawLabel: 'Signature drawing area',
  clearDrawing: 'Clear',
  signing: 'Signing',
  closeLabel: 'Close',
  consentMissing: 'Check the box to agree to sign electronically.',
  nameMissing: 'Type your full name.',
  optionMissing: 'Pick an option.',
  // Declining
  declineTitle: 'Not right now',
  declineIntro: 'Tell us why if you like. This is optional.',
  declineReasonLabel: 'Your reason',
  declineSend: 'Let them know',
  declineKeep: 'Go back',
  // End states
  signedTitle: 'Thank you, your proposal is signed',
  /** The date is on the card under it, so it is not said twice. */
  signedBy: (name: string, tier: string): string => `Signed by ${name} for the ${tier} option.`,
  signedOn: (when: string): string => `Signed ${when}`,
  downloadPdf: 'Download your signed copy',
  /** While the page is still asking for it, every few seconds. */
  pdfPreparing: 'Your signed copy is being prepared. This page updates on its own.',
  /** After the page has stopped asking (about two minutes). */
  pdfPreparingLate: 'Your signed copy is still being prepared. Check back in a few minutes.',
  signedStepDone: 'Proposal signed',
  signedStepCopy: 'Your signed copy is saved as a PDF.',
  signedStepNext: 'What happens next',
  signedStepNextBody: (company: string): string => `${company} has your signed proposal and will be in touch.`,
  declinedTitle: 'You said not right now',
  declinedBody: (company: string): string => `${company} has been told. You can call any time if you change your mind.`,
  expiredTitle: 'This proposal has expired',
  expiredBody: (company: string): string => `${company} can send you a fresh one.`,
  goneTitle: "This proposal link doesn't work.",
  goneBody: 'Call the company that sent it and they will send a new one.',
  tryAgain: 'Try again',
  loadFailed: 'We could not load your proposal.',
} as const;

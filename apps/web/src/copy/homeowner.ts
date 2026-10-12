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
  validUntil: (date: string): string => `Good until ${date}`,
  chooseOne: 'Pick the option that fits you best.',
  mostPopular: 'Most popular',
  estimateLabel: 'Estimate',
  includedHeading: "What's included",
  totalLabel: 'Total',
  monthlyLine: (monthly: string, months: number, aprPercent: string): string => `Or about ${monthly} a month for ${months} months at ${aprPercent}% APR (estimate)`,
  chooseOption: (name: string): string => `Choose ${name}`,
  optionSelected: 'Chosen',
  signAndAccept: (cents: number): string => `Sign and accept ${money(cents)}`,
  declineLink: 'Not right now',
  callUs: (company: string): string => `Call ${company}`,
  questions: 'Questions? We are happy to help.',
  // Signing
  signTitle: 'Sign your proposal',
  signSummary: (name: string, cents: number): string => `${name}: ${money(cents)}`,
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
  signedBy: (name: string, when: string, option: string): string => `Signed by ${name} on ${when} for ${option}`,
  downloadPdf: 'Download your signed copy',
  pdfPreparing: 'Your signed copy is being prepared. Check back in a minute.',
  declinedTitle: 'You said not right now',
  declinedBody: (company: string): string => `${company} has been told. You can call any time if you change your mind.`,
  expiredTitle: 'This proposal has expired',
  expiredBody: (company: string): string => `Call ${company} for a fresh one.`,
  goneTitle: "This proposal link doesn't work.",
  goneBody: 'Call the company that sent it and they will send a new one.',
  tryAgain: 'Try again',
  loadFailed: 'We could not load your proposal.',
} as const;

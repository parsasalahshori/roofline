/**
 * Words the two homeowner pages share: the instant quote page (/q/:slug) and the proposal page (/p/:token). The company's
 * own name and phone are on the letterhead; the trust row under the first step says what the company itself gave. Nothing
 * here states a number or a claim the company did not give: the facts come from the company, the words around them from here.
 */
export const publicCopy = {
  /** The pill in the page's header: it dials the company. */
  call: 'Call',
  callAria: (phone: string): string => `Call ${phone}`,

  /** "Step 2 of 3" over the progress bars of the quote page. */
  stepOf: (step: number, total: number): string => `Step ${step} of ${total}`,

  // The trust row (REDESIGN 7.2): each item is optional and comes from the company's own settings.
  trustLabel: 'About the company',
  /**
   * "2,400+ homeowners" or "2,400 Google reviews". The source is the company's own words after the count; one that does
   * not already name the people or the reviews ("Google") gets "reviews" after it.
   */
  ratingCaption: (count: number, source: string, plus = false): string => {
    const n = `${count.toLocaleString('en-US')}${plus ? '+' : ''}`;
    return /\b(reviews?|ratings?|homeowners?|customers?|clients?|families)\b/i.test(source) ? `${n} ${source}` : `${n} ${source} ${count === 1 && !plus ? 'review' : 'reviews'}`;
  },
  /** "4.9 from 2,400+ homeowners": the rating as one line. */
  ratingLine: (value: number, caption: string): string => `${value.toFixed(1)} from ${caption}`,
  badgesLabel: 'Badges',

  // What the company's window catalog adds to the homeowner pages: the offer, financing, what every window includes.
  offerLabel: 'Current offer',
  offerTerms: 'Terms',
  financingMore: 'Financing details',
  includedTitle: 'Every window includes',
  tiersTitle: 'Three choices for every window',
  colorsGrids: 'Colors and grids are chosen at your visit.',
  sinceCaption: 'In business since',
  licenseCaption: 'Licensed',

  /** With fewer than two facts the row says what the visit is instead. No number in it: only what the company does. */
  visitTitle: 'What happens at the visit',
  visitChecks: [
    { lead: 'We check the roof', rest: ' and measure every window.' },
    { lead: 'You get one written price', rest: ' for each option.' },
  ],

  // The instant quote page (/q/:slug)
  measuringNote: 'Takes about 5 seconds.',
  roofName: 'Roof replacement',
  windowsName: 'Windows',
  guttersWhy: 'We measure gutters in person, so the number is right.',
  slotsZone: (zone: string): string => `Times are in ${zone}.`,
  /** Under the button of the "we'll call you" form: which number the call comes from (the company's own), and that texts are only by request. */
  callFrom: (phone: string): string => `The call comes from ${phone}. No texts unless you ask.`,

  /** A range of prices written short for a card: $11,400 and $13,900 read $11,400–13,900. */
  rangeShort: (low: string, high: string): string => `${low}–${high.replace(/^\$/, '')}`,
} as const;

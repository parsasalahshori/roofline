import type { Tier, WindowAdders, WindowSizeClass } from '@roofline/shared';

/*
 * Settings, Prices: the Windows catalog section. What a homeowner is offered for windows on the company's quote page and
 * in its app: the plain style choices, the three levels' names, the price list, what every window includes, and the facts
 * the pages show. Shared words (save, saved, retry, loadFailed, officeReadOnly) are in tiers.ts.
 */
export const windowCatalog = {
  title: 'Windows catalog',
  intro: 'What homeowners see for windows on your quote page and in your app: three plain choices of window, the names of your three levels, what every window includes, and your window prices.',

  choicesTitle: 'Window choices',
  choicesHelp: 'Homeowners pick one for each window. A choice marked "price at the visit" is counted but gets no instant price.',
  choiceLabel: (n: number) => `Choice ${n}: name`,
  choiceHint: (n: number) => `Choice ${n}: a few words under it`,
  choiceAtVisit: (label: string) => `${label}: price at the visit`,

  levelsTitle: 'Levels',
  levelsHelp: 'Your own name for Good, Better and Best, and one line under it.',
  levelRank: { good: 'Good', better: 'Better', best: 'Best' } satisfies Record<Tier, string>,
  levelLabel: (rank: string) => `${rank}: name`,
  levelNote: (rank: string) => `${rank}: one line`,
  levelName: (rank: string) => `${rank}: product name`,

  pricesTitle: 'Window prices',
  pricesHelp: 'Installed price of one white window with clear glass and no grids, in dollars, by size and level. Colors and grids are chosen at the visit.',
  sizeNames: { small: 'Small (up to 72 in)', standard: 'Standard (to 101 in)', large: 'Large (to 120 in)', picture: 'Picture (over 120 in)' } satisfies Record<WindowSizeClass, string>,
  priceCell: (size: string, level: string) => `${size}, ${level} ($)`,
  stylePricesTitle: 'Price by window choice',
  stylePricesHelp: 'Added to (or, with a minus, taken off) the price above for each choice. Leave 0 for the first choice.',
  stylePriceCell: (choice: string, level: string) => `${choice}, ${level} (+/- $)`,

  addersTitle: 'Extras per window',
  addersHelp: 'Frosted glass is asked in the app (bathroom windows). The rest are chosen at the visit.',
  adders: {
    frostedCents: 'Frosted glass (bathroom) ($)',
    exteriorColorCents: 'Exterior color ($)',
    woodInteriorCents: 'Wood-look interior ($)',
    gridColonialCents: 'Colonial grids ($)',
    gridQueenAnneCents: 'Queen Anne grids ($)',
  } satisfies Record<keyof WindowAdders, string>,

  includedTitle: 'Every window includes',
  includedLabel: 'One line each (up to 8)',
  includedHelp: 'For example: Argon gas fill.',

  trustTitle: 'Trust facts',
  trustHelp: 'Shown under the address and on the quote. Leave a box empty to leave it out.',
  ratingValue: 'Rating (1 to 5)',
  ratingCount: 'Out of how many',
  ratingPlus: 'Show as "2,400+"',
  ratingSource: 'Who rated you',
  ratingSourceHelp: 'The words after the count: homeowners, or Google reviews.',
  sinceYear: 'In business since (year)',
  licenseState: 'License state (2 letters)',
  licenseNumber: 'License number',
  badge: (n: number) => `Badge ${n}`,
  badgeHelp: 'Up to three short badges, like A+ BBB.',

  offerTitle: 'Offer banner',
  offerHelp: 'A banner across the top of your quote pages. Leave the title empty for none.',
  offerText: 'Offer',
  offerUrl: 'Link to the terms (https://)',

  financingTitle: 'Financing',
  financingHelp: 'One line under the prices. Leave it empty for none.',
  financingText: 'Financing line',
  financingUrl: 'Link for details (https://)',

  useDefaults: 'Use the standard catalog',
  defaultsRestored: 'Back to the standard catalog',

  // Field errors
  required: 'Fill this in.',
  money: 'Enter an amount in dollars.',
  moneyRange: 'Enter an amount from 0 to 10,000.',
  moneyDiff: 'Enter an amount from -10,000 to 10,000.',
  ratingRange: 'Enter a number from 1 to 5.',
  countRange: 'Enter a whole number.',
  yearRange: 'Enter a year like 2012.',
  stateRange: 'Enter two letters.',
  needsBoth: 'Fill in both, or leave both empty.',
  needsRatingParts: 'A rating needs its value, its count and who rated you.',
  httpsOnly: 'Use a web address that starts with https://',
  tooManyLines: 'Up to 8 lines.',
  lineTooLong: 'Keep each line under 60 letters.',
} as const;

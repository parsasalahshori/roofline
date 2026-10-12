/** Whole dollars, as the screen shows every amount. */
const wholeDollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
/** Two decimals, for the exact daily amount in dollars and cents. */
const cents2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** The review kit's words for a create_ad_campaign step: its preview and its Edit fields. */
export const stepAds = {
  /** The platform the campaign runs on. */
  platformName: { google: 'Search ads', meta: 'Social media ads' } as const,
  /** The exact floored daily amount in cents, floor(max / days), so that days of spend stay within the approved maximum. Matches the shared preview. */
  dailyFor: (dailyCents: number, days: number): string =>
    `${cents2.format(dailyCents / 100)} a day for ${days} ${days === 1 ? 'day' : 'days'}`,
  /** A whole-dollar amount from cents, for the Edit help. */
  money: (cents: number): string => wholeDollars.format(cents / 100),
  /** Shown to an office user, who may not approve spending. */
  ownerOnly: 'Only the owner can approve spending',
  /** Under the hail-area map. */
  hailNote: 'Radar-estimated hail area',
  thumbLabel: 'Map of the hail area the ads cover',
  headlineLabel: 'Headline',
  descriptionLabel: 'Description',
  keywordsLabel: 'Keywords, one per line',
  primaryTextLabel: 'Main text',
  maxLabel: 'Most to spend (dollars)',
  maxHelp: (current: string): string => `You can lower this. To spend more, ask for a new plan. Now ${current}`,
  daysLabel: 'Days to run',
  photoLabel: 'Photo',
  noPhoto: 'No photo',
  /** A Settings photo's place in the list, by its order there. */
  photoN: (n: number): string => `Photo ${n}`,
  /** A picked photo that is no longer in Settings. */
  photoGone: 'A photo no longer in Settings',
  raisedError: (max: string): string => `Please keep it at or under ${max}.`,
} as const;

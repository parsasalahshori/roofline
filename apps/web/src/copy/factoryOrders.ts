import { fractionInches, windowStyleName, type OrderRounding, type StyleLimits, type WindowStyle } from '@roofline/shared';

/*
 * Settings, Prices: the Factory orders section. How a window measured from on-site photos becomes the size
 * the factory builds, and each style's factory limits. Shared words (save, saved, retry, loadFailed,
 * officeReadOnly) are in tiers.ts.
 */
export const factoryOrders = {
  title: 'Factory orders',
  intro:
    'How window order sizes are worked out from on-site photo measurements. Draft orders use these when they are refreshed or marked ready. Orders already marked ready keep their sizes.',

  widthDeduction: 'Taken off the width (in)',
  heightDeduction: 'Taken off the height (in)',
  deductionHelp: 'Windows are ordered a little smaller than the opening so they fit.',
  rounding: 'Round sizes down to',
  roundingOption: (step: OrderRounding) => `${fractionInches(step)} in`,
  uncertaintyFactor: 'Photo error taken off (times)',
  uncertaintyHelp: 'How many times the photo’s likely error comes off each size, so a window is never ordered too big. Enter 0 to ignore it.',
  checkUncertainty: 'Flag a window when the photo could be off by more than (in)',

  limitsTitle: 'Factory limits',
  limitsHelp: 'The sizes your factory can build, by window style. Lines outside them cannot be ordered.',
  style: 'Window style',
  styleOption: (style: WindowStyle) => windowStyleName(style),
  limit: {
    minWidthIn: 'Smallest width (in)',
    maxWidthIn: 'Largest width (in)',
    minHeightIn: 'Smallest height (in)',
    maxHeightIn: 'Largest height (in)',
    maxUnitedIn: 'Largest width plus height (in)',
    maxAreaSqFt: 'Largest window (sq ft)',
    maxTemperedAreaSqFt: 'Largest tempered window (sq ft)',
  } satisfies Record<keyof StyleLimits, string>,

  useDefaults: 'Use the standard values',
  defaultsRestored: 'Back to the standard values',

  // Field errors
  required: 'Enter a number.',
  range: (min: number, max: number) => `Enter a number from ${min} to ${max}.`,
  minOverMax: 'The smallest size is bigger than the largest.',
  /** At the top of the form when a field of another window style is wrong. */
  otherStyleWrong: (style: WindowStyle) => `Check the limits for ${windowStyleName(style)}.`,
} as const;

/*
 * The Financing and Estimate sections of Settings, Prices (E1 Task 18). Shared words (save, saved, retry,
 * loadFailed, officeReadOnly) are in tiers.ts.
 */

/** Financing: the APR and term that proposals show as a monthly figure. Both empty hides the line. */
export const financeCopy = {
  title: 'Financing',
  aprLabel: 'APR (%)',
  termLabel: 'Term (months)',
  // Under the fields: what the two values do on a proposal
  help: 'Shown on proposals. Enter 0 for no interest. Leave both empty to hide the financing line.',
  // When neither value is set
  notSet: 'Financing is not set. Proposals show no financing line.',
  // Field errors
  pairRequired: 'Enter both the APR and the term, or leave both empty.',
  aprRange: 'Enter an APR from 0 to 100.',
  termRange: 'Enter a whole number of months from 1 to 600.',
} as const;

/** Estimate settings: the defaults every new estimate starts from, and the proposal terms. */
export const estimateCopy = {
  title: 'Estimates',
  defaultPitch: 'Default pitch (x/12)',
  overhang: 'Overhang (ft)',
  validDays: 'Proposal valid for (days)',
  changeClause: 'Estimate change clause',
  // Under the change clause switch: what it does on a proposal
  changeClauseHelp: 'Adds a line to proposals saying the price changes if the measured roof differs.',
  aerial: 'Aerial measure',
  // Under the aerial switch: when it is shown and what it does
  aerialHelp: 'Orders an aerial roof measurement for each new estimate.',
  // Field errors
  pitchRange: 'Enter a pitch from 0 to 24.',
  pitchStep: 'Use whole numbers or halves, such as 6 or 6.5.',
  overhangRange: 'Enter an overhang from 0 to 3 feet.',
  overhangStep: 'Use one decimal place, such as 1.5.',
  validDaysRange: 'Enter a whole number of days from 1 to 180.',
  required: 'Enter a number.',
} as const;

/** The generic Edit sheet's own words (the title, Save and Cancel come from `review`). */
export const stepEdit = {
  /** Under the reps field while the team loads. */
  loadingTeam: 'Loading your team…',
  /** Under the reps field when the team has nobody to pick. */
  noTeam: 'Nobody on your team to pick yet.',
  /** Under a lines field: one item per line. */
  linesHelp: 'One item per line.',
  /** Under a pick field, when there is nothing to pick from. */
  noOptions: 'Nothing to pick from yet.',
  /** Shown when the payload fails the shared check with no sentence of its own. */
  checkFailed: 'Please check this step.',
} as const;

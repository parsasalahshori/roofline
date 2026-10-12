import type { BaselineKey, TimePeriod } from '@roofline/shared';

/*
 * The Agents screen (A1 Task 8): window and tab titles and the placeholder lines. Agent names are
 * AGENT_LABEL in status.ts. Tasks 9 to 12 add the real words here.
 */
/** Words every Agents component shares (one source for the estimate mark and the placeholder). */
export const agentsCommon = {
  estimate: '(estimate)',
  comingSoon: 'Coming soon',
  // The money line: "≈ $870 of staff time at $28/hour (estimate)" then a link for the owner
  staffTime: 'of staff time at',
  perHour: '/hour',
  changeRate: 'Change the rate',
  changeRateHref: '/settings/company',
  retry: 'Try again',
  refreshFailed: 'We could not refresh this. Showing what we had.',
} as const;

export const agents = {
  // The tab row in the Agents window
  tabsLabel: 'Agents sections',
  tabs: { overview: 'Overview', feed: 'Feed', waiting: 'Waiting on you' },
  agentComingSoon: 'This agent’s page is coming soon.',

  // --- Task 11: feed and waiting ---
  feedFiltersLabel: 'Show work by',
  feedFilterAll: 'All',
  feedListLabel: 'What your agents did',
  feedShowMore: 'Show more',
  feedEmpty: 'Nothing yet. When your agents do something, it shows up here.',
  feedLoadError: 'The record could not be loaded.',
  feedOpen: 'Open',
  waitingListLabel: 'Waiting',
  waitingGroupYou: 'You',
  waitingGroupOffice: 'Office',
  waitingEmpty: 'Nothing is waiting on anyone.',
  waitingLoadError: 'The waiting list could not be loaded.',
  waitingOpen: 'Open',
  waitingLoading: 'Loading what is waiting',
  feedLoading: 'Loading the record',
} as const;

// --- Task 9: Agents window ---
export const agentsWindow = {
  totalsSaved: 'saved this month',
  separator: '·',
  successRate: 'Success rate',
  successRateNone: 'Not enough runs yet',
  notApproved: 'Not approved:',
  finishedToday: 'Finished today',
  timeSaved: 'Time saved this month',
  waiting: 'Waiting on you:',
  howWeCount: 'How we count',
  howWeCountHref: '/settings/agents',
  chartLabel: 'Tasks finished in the last 14 days',
  chartDate: 'Date',
  chartFinished: 'Finished',
  status: { on: 'On', paused: 'Paused', waiting: 'Waiting on you', coming_soon: 'Coming soon' },
  loadError: 'We could not load your agents. Try again in a moment.',
  gridLabel: 'Your agents',
  loading: 'Loading your agents',
} as const;

// --- Task 10: agent page ---
export const agentPage = {
  periodLabel: 'Time period',
  periods: { today: 'Today', week: 'This week', month: 'This month', last90: 'Last 90 days' } satisfies Record<TimePeriod, string>,
  loading: 'Loading this agent',
  pausedNote: 'This agent is paused, so it cannot be run now. Turn it back on first.',
  loadError: 'We could not load this agent. Try again in a moment.',
  timeSaved: 'Time saved in this period:',
  breakdownTitle: 'Where the time came from',
  breakdownCaption: 'Time saved by kind of work',
  colWork: 'Work',
  colUnits: 'Done',
  colTime: 'Time saved',
  breakdownEmpty: 'Nothing counted in this period yet.',
  rulesTitle: 'What it does',
  rulesEmpty: 'No rules to show yet.',
  recentTitle: 'Recent work',
  recentEmpty: 'Nothing here yet.',
  pauseLabel: 'Paused',
  pausedBy: 'Paused by',
  pauseTitle: 'Pause this agent?',
  pauseBody: 'It will stop doing new work until you turn it back on. Work already waiting for approval stays where it is.',
  pauseConfirm: 'Pause',
  pauseCancel: 'Cancel',
  pauseError: 'We could not change that. Try again.',
  runNowButton: 'Check for hail now',
  runNowAgain: 'You can run it again at',
  worksWhenAsked: 'Works when you ask',
  answersCalls: 'Answers as calls come in',
  runError: 'We could not start it. Try again in a moment.',
  /** Work label per baseline key (Time breakdown table). */
  baselineLabels: {
    text_sent: 'Texts sent',
    email_sent: 'Emails sent',
    route_built: 'Routes planned',
    ad_campaign: 'Ad campaigns set up',
    proposal_sent: 'Proposals sent',
    exact_report: 'Roof reports ordered',
    call_answered: 'Calls answered (incl. bookings)',
    spam_call: 'Spam calls blocked',
    booking: 'Appointments booked',
    text_reply: 'Text replies (incl. bookings)',
    claim_packet: 'Claim packets built',
    reminder_sent: 'Reminders sent',
    install_moved: 'Installs moved',
    follow_up_sent: 'Follow-ups sent',
    demo: 'Demo steps',
  } satisfies Record<BaselineKey, string>,
} as const;

// --- Task 12: time baselines ---
export const timeBaselines = {
  title: 'How we count time saved',
  intro: 'Each kind of finished work saves your staff some minutes. These numbers are estimates, and you can change them.',
  onlyFinished: 'Only finished work counts.',
  tableCaption: 'Minutes saved for each kind of work',
  colWork: 'Work',
  colUnit: 'Counted per',
  colBasis: 'How we count it',
  colMinutes: 'Minutes saved',
  minutesSuffix: 'minutes',
  /** Visually hidden label prefix for each input: 'Minutes saved for <work>'. */
  inputLabelPrefix: 'Minutes saved for',
  defaultIs: 'Standard:',
  reset: 'Reset to default',
  /** Reset button accessible name: 'Reset to default for <work>'. */
  resetLabelSuffix: 'for',
  save: 'Save',
  saving: 'Saving',
  saved: 'Saved.',
  saveError: 'We could not save that. Try again in a moment.',
  ownerOnly: 'Only the owner can change these.',
  loadError: 'We could not load these numbers. Try again in a moment.',
  loading: 'Loading these numbers',
  /** Cap and call-length words. capWords(120) -> 'At most 120 minutes per batch'. */
  capPrefix: 'At most',
  capSuffix: 'minutes per batch',
  plusCallLength: 'plus the call’s length',
  errorNotNumber: 'Enter a number of minutes, like 5 or 7.5.',
  errorRange: 'Use a number from 0 to 600.',
  errorStep: 'Use whole or half minutes, like 5 or 5.5.',
  ratePrefix: 'Staff time is valued at',
  rateSuffix: 'an hour.',
  rateLinkText: 'Change this in Company settings',
  rateHref: '/settings/company',
  recountButton: 'Recount the last 90 days with these numbers',
  recountWorking: 'Checking',
  recountError: 'We could not recount. Try again in a moment.',
  recountTitle: 'Recount the last 90 days?',
  recountIntro: 'This changes the time saved shown for the last 90 days.',
  recountBefore: 'Now:',
  recountAfter: 'After the recount:',
  recountSteps: 'Finished steps counted:',
  recountConfirm: 'Recount',
  recountCancel: 'Cancel',
  recountClose: 'Close',
  recountUnsaved: 'Save your changes first, then recount.',
  recountDone: 'Done. The last 90 days now use these numbers.',
} as const;

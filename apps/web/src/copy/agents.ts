/*
 * The Agents screen (A1 Task 8): window and tab titles and the placeholder lines. Agent names are
 * AGENT_LABEL in status.ts. Tasks 9 to 12 add the real words here.
 */
export const agents = {
  // The tab row in the Agents window
  tabsLabel: 'Agents sections',
  tabs: { overview: 'Overview', feed: 'Feed', waiting: 'Waiting on you' },
  overviewComingSoon: 'Your agents and what they did today are coming soon.',
  feedComingSoon: 'The record of what your agents did is coming soon.',
  waitingComingSoon: 'The tasks waiting on you are coming soon.',
  agentComingSoon: 'This agent’s page is coming soon.',
  // The Agents tab in Settings
  settingsTab: 'Agents',
  settingsComingSoon: 'How we count time saved is coming soon.',

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
} as const;

// --- Task 9: Agents window ---
export const agentsWindow = {
  estimate: '(estimate)',
  totalsPrefix: 'About',
  totalsSaved: 'saved this month',
  separator: '·',
  successRate: 'Success rate',
  successRateNone: 'Not enough runs yet',
  notApproved: 'Not approved:',
  finishedToday: 'Finished today',
  timeSaved: 'Time saved this month',
  waiting: 'Waiting on you:',
  comingSoon: 'Coming soon',
  howWeCount: 'How we count',
  howWeCountHref: '/settings/agents',
  chartLabel: 'Tasks finished in the last 14 days',
  chartDate: 'Date',
  chartFinished: 'Finished',
  status: { on: 'On', paused: 'Paused', waiting: 'Waiting on you', coming_soon: 'Coming soon' },
  loadError: 'We could not load your agents. Try again in a moment.',
  gridLabel: 'Your agents',
} as const;

// --- Task 10: agent page ---
import type { BaselineKey, TimePeriod } from '@roofline/shared';

export const agentPage = {
  periodLabel: 'Time period',
  periods: { today: 'Today', week: 'This week', month: 'This month', last90: 'Last 90 days' } satisfies Record<TimePeriod, string>,
  loading: 'Loading this agent',
  loadError: 'We could not load this agent. Try again in a moment.',
  timeTitle: 'Time saved',
  /** After hoursLabel(), e.g. 'about 4.5 hours (estimate)'. */
  estimateSuffix: '(estimate)',
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
  recentOpenLabel: 'Open',
  pauseLabel: 'Paused',
  pausedBy: 'Paused by',
  pausedSince: 'Paused since',
  pauseTitle: 'Pause this agent?',
  pauseBody: 'It will stop doing new work until you turn it back on. Work already waiting for approval stays where it is.',
  pauseConfirm: 'Pause',
  pauseCancel: 'Cancel',
  pauseError: 'We could not change that. Try again.',
  ownerOnly: 'Only the owner can pause or resume an agent.',
  runNowButton: 'Check for hail now',
  runNowAgain: 'You can run it again at',
  worksWhenAsked: 'Works when you ask',
  answersCalls: 'Answers as calls come in',
  comingSoon: 'Coming soon',
  runStarted: 'Started. It will finish in a moment.',
  runError: 'We could not start it. Try again in a moment.',
  /** Work label per baseline key (Time breakdown table). */
  baselineLabels: {
    text_sent: 'Texts sent',
    email_sent: 'Emails sent',
    route_built: 'Routes planned',
    ad_campaign: 'Ad campaigns set up',
    proposal_sent: 'Proposals sent',
    exact_report: 'Roof reports ordered',
    call_answered: 'Calls answered',
    spam_call: 'Spam calls blocked',
    booking: 'Appointments booked',
    text_reply: 'Text replies',
    claim_packet: 'Claim packets built',
    reminder_sent: 'Reminders sent',
    install_moved: 'Installs moved',
    follow_up_sent: 'Follow-ups sent',
    demo: 'Demo steps',
  } satisfies Record<BaselineKey, string>,
} as const;

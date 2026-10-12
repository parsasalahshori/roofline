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

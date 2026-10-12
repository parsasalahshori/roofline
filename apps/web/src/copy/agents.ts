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
} as const;

/** Settings, Connections: where the ad accounts and the person's calendar get connected. */
export const connections = {
  later: 'Connect your Google and Facebook ad accounts here. Coming with setup.',
  calendarTitle: 'Your calendar',
  providers: { google: 'Google Calendar', microsoft: 'Outlook' },
  connect: { google: 'Connect Google Calendar', microsoft: 'Connect Outlook' },
  notConfigured: 'Calendar connections aren\'t set up yet.',
  account: 'Account',
  calendarLabel: 'Calendar',
  lastSynced: (when: string) => `Last synced ${when}`,
  neverSynced: 'Not synced yet.',
  disconnect: 'Disconnect',
  disconnectConfirm: 'Your appointments stay in Roofline and on your calendar.',
  confirmYes: 'Disconnect',
  confirmNo: 'Keep it',
  reconnectTitle: 'Reconnect your calendar',
  loading: 'Loading your calendar…',
  loadFailed: 'Your calendar could not be loaded.',
  toasts: {
    connected: 'Calendar connected.',
    failed: 'Couldn\'t connect your calendar. Try again.',
    canceled: 'Calendar connection canceled.',
    notSetUp: 'Calendar connections aren\'t set up yet.',
  },
  chooseFailed: 'Couldn\'t change the calendar. Try again.',
  disconnectFailed: 'Couldn\'t disconnect your calendar. Try again.',
  disconnected: 'Calendar disconnected.',
  /** The short brand word for the appointment sync line ('On your Google calendar'); `providers` is the full product name. */
  providerName: { google: 'Google', microsoft: 'Outlook' },
} as const;

/** The name of a provider as the person sees it: 'google' or 'microsoft'. */
export function providerWord(provider: 'google' | 'microsoft'): string {
  return connections.providers[provider];
}

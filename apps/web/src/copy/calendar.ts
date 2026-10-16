/** The Calendar page: its controls, the three views, the grid and the states around it. Plain words. */
export const calendar = {
  today: 'Today',
  previous: 'Previous',
  next: 'Next',
  viewLabel: 'Calendar view',
  viewDay: 'Day',
  viewWeek: 'Week',
  viewList: 'List',
  newAppointment: 'New appointment',
  /** The small heading over the person chips, and the chips' group name. */
  people: 'People',
  peopleLabel: 'Show appointments for',
  showCanceled: 'Show canceled',
  busy: 'Busy',
  allDay: 'All day',
  gridLabel: 'Calendar time grid',
  /** The row of days on a phone. */
  dayStripLabel: 'Pick a day',
  loadMore: 'Load more',
  tryAgain: 'Try again',
  empty: 'Nothing scheduled.',
  emptyHint: 'The inspections and installs you book, and the ones Front Desk books for you, will list here by day.',
  loadError: 'The calendar could not be loaded.',
  zoneNote: (zoneName: string) => `Times are shown in ${zoneName}, your company time zone.`,
  /** The list view: one panel for each day, with a table of its visits. */
  count: (appointments: number) => (appointments === 1 ? '1 appointment' : `${appointments} appointments`),
  todayTag: 'Today',
  columns: { time: 'Time', visit: 'Visit', customer: 'Customer', address: 'Address', person: 'Person', status: 'Status' },
  unassigned: 'Nobody yet',
  noCustomer: 'No customer',
  status: { scheduled: 'Scheduled', completed: 'Done', canceled: 'Canceled', no_show: 'No-show' },
  /** What a block says when the pointer rests on it: every part that was cut short on the grid. */
  eventTitle: (parts: ReadonlyArray<string>) => parts.join(' · '),
  /** Between the customer and the address, on a phone's row. */
  metaSeparator: ' · ',
  /** The time a block starts and ends, as "9:00 AM - 10:00 AM". */
  timeRange: (start: string, end: string) => `${start} - ${end}`,
} as const;

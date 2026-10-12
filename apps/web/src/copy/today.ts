export const today = {
  greeting: (part: 'morning' | 'afternoon' | 'evening', firstName: string) =>
    firstName ? `Good ${part}, ${firstName}` : `Good ${part}`,
  needYourOk: 'Need your OK',
  nothingNeedsYou: 'Nothing needs your OK right now.',
  seeAll: (n: number) => `See all ${n}`,
  appointments: "Today's appointments",
  noAppointments: 'Nothing on your calendar today.',
  seeEveryone: "See everyone's day",
  followUps: 'Follow up today',
  followUpsLabel: 'Jobs to follow up today',
  appointmentsLabel: "Today's appointments list",
  /** The label for each appointment kind, keyed by the shared AppointmentKind values. */
  kindLabel: { inspection: 'Inspection', install: 'Install', adjuster: 'Adjuster', other: 'Other' },
  allDay: 'All day',
  /** One follow-up line: the job's next step, with its date when it has one. */
  nextStep: (text: string | null) => (text === null ? 'No next step set' : text),
  fromFrontDesk: 'From Front Desk',
  fromFrontDeskUrgent: 'Urgent, from Front Desk',
  draftsLabel: 'Plans waiting for your OK',
} as const;

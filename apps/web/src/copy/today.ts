/** My day: what needs the person today. */
export const today = {
  needYourOk: 'Need your OK',
  nothingNeedsYou: 'Nothing needs your OK right now.',
  seeAll: (n: number) => `See all ${n}`,
  /** My day is the person's own day: the list holds the visits assigned to them, not the whole company's (Home has those). */
  appointments: 'Your visits today',
  /** "3 visits" beside the heading of the visits list. */
  visitsCount: (n: number) => (n === 1 ? '1 visit' : `${n} visits`),
  noAppointments: 'No visits for you today',
  noAppointmentsHelp: 'A visit assigned to you shows up here, with the time and the address.',
  /** The help under that, when the company has leads waiting for an inspection: "10 leads have no inspection yet. ..." */
  noVisitsLeads: (leads: number) =>
    `${leads} ${leads === 1 ? 'lead has' : 'leads have'} no inspection yet. A visit assigned to you shows up here.`,
  bookVisit: 'Book a visit',
  seeEveryone: "See everyone's day",
  followUps: 'Follow up today',
  followUpsLabel: 'Jobs to follow up today',
  appointmentsLabel: "Today's appointments list",
  /** The label for each appointment kind, keyed by the shared AppointmentKind values. */
  kindLabel: { inspection: 'Inspection', install: 'Install', adjuster: 'Adjuster', other: 'Other' },
  allDay: 'All day',
  /** "4265 Harney St · from Front Desk" */
  detail: (parts: readonly string[]) => parts.join(' · '),
  fromFrontDesk: 'From Front Desk',
  /** The visit that is under way, the one that comes next, and one that is over. */
  now: 'Now',
  next: 'Next',
  done: 'Done',
  /** The name of the button that opens driving directions to a visit. */
  directionsTo: (who: string) => `Directions to ${who}`,
  /** One follow-up line: the job's next step, with its date when it has one. */
  nextStep: (text: string | null) => (text === null ? 'No next step set' : text),
  thisMonth: 'This month',
  /** The signed tile's name under the "This month" heading, which already says the month. */
  signed: 'Signed',
  signedToday: 'Signed today',
  signedLabel: 'Proposals signed today',
  signedBy: (name: string) => `Signed by ${name}`,
  signedNone: 'No proposals signed today.',
  signedEstimate: (money: string) => `Estimate ${money}`,
  fromFrontDeskUrgent: 'Urgent, from Front Desk',
  draftsLabel: 'Plans waiting for your OK',
  loadFailed: 'We could not load this.',
} as const;

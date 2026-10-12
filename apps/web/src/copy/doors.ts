/** The door-knocking routes under Storm, on the phone. */
export const doors = {
  /** The link to the routes list, in the Storm window and the More sheet. */
  myRoutesLink: 'My routes',

  // My routes
  myRoutesEmpty: 'No routes yet. When a storm plan builds routes for you, they show up here.',
  myRoutesLoading: 'Loading your routes',
  myRoutesError: "We couldn't load your routes.",
  routeStatus: { ready: 'Ready', in_progress: 'In progress', done: 'Done' },
  /** "3 of 12 doors" */
  progress: (done: number, total: number) => `${done} of ${total} doors`,
  /** The route link's accessible name: the route name then its progress. */
  routeLinkLabel: (name: string, done: number, total: number) => `${name}, ${done} of ${total} doors`,

  // One route
  routeLoading: 'Loading the route',
  routeError: "We couldn't load this route.",
  routeMapLabel: 'Map of the doors on this route',
  stopsHeading: 'Doors in order',
  /** "Door 3 of 12" */
  doorOf: (n: number, total: number) => `Door ${n} of ${total}`,
  /** The hail size line under an address; always radar-estimated. */
  hailLine: (inches: number) => `Radar-estimated hail up to ${inches} in`,
  /** Shown in place of an address when the home has none saved. */
  noAddress: 'Home with no saved address',
  navigate: 'Navigate',
  navigateAppleBase: 'https://maps.apple.com/?daddr=',
  navigateGoogleBase: 'https://www.google.com/maps/dir/?api=1&destination=',
  routeDone: 'Route done. Nice work.',
  backToRoutes: 'Back to my routes',
  doneMark: 'Done',

  // Outcome buttons and the Wants a check sheet
  outcomeHeading: 'How did it go?',
  outcomes: {
    not_home: 'Not home',
    wants_check: 'Wants a check',
    not_interested: 'Not interested',
    has_roofer: 'Has a roofer',
    do_not_knock: 'Do not knock',
  },
  sheetTitle: 'Wants a check',
  sheetClose: 'Close',
  leadName: 'Name',
  leadPhone: 'Phone',
  leadEmail: 'Email',
  leadOkToText: 'OK to text about this',
  leadNote: 'Note',
  leadSave: 'Save',
  nameRequired: 'Enter a name.',
  contactRequired: 'Enter a phone number or an email.',
  phoneInvalid: 'Enter a 10-digit phone number.',
  emailInvalid: 'Enter a valid email.',
  /** Shown when the network failed; the tap can be repeated. */
  notSaved: 'Not saved — try again',
  saving: 'Saving',
} as const;

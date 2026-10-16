/*
 * The Settings Schedule tab (C1 Task 25): company hours for the owner, and everyone's own hours.
 * Weekday keys follow WEEKDAYS in @roofline/shared; the words here are what the person reads.
 */
export const schedule = {
  loading: 'Loading…',
  loadFailed: 'We could not load the schedule.',

  companyTitle: 'Company hours',
  rulesTitle: 'Scheduling rules',
  yourTitle: 'Your hours',
  useCompanyHours: 'Use the company hours',
  // Who may change the company hours, shown to everyone else
  ownerOnlyNote: 'Only the owner can change the company hours and these settings.',

  weekday: {
    mon: 'Monday',
    tue: 'Tuesday',
    wed: 'Wednesday',
    thu: 'Thursday',
    fri: 'Friday',
    sat: 'Saturday',
    sun: 'Sunday',
  },
  // The text beside each day's switch
  open: 'Open',
  closed: 'Closed',
  addRange: 'Add hours',
  removeRange: 'Remove',
  start: 'Start',
  end: 'End',

  travelBuffer: 'Travel time between visits (minutes)',
  minNotice: 'Minimum notice (minutes)',
  stuckAfter: 'Days before a job is stuck',
  notWholeNumber: 'Enter a whole number.',

  save: 'Save',
  saved: 'Saved.',
} as const;

import type { AppointmentKind, QuoteStatus } from '@roofline/shared';

/** One job's window: header, stage stepper, edit sheet, sections. */
export const job = {
  loading: 'Loading job',
  loadFailed: "We couldn't load this job. Try again in a minute.",
  retry: 'Try again',
  notFoundTitle: 'Not found',
  notFoundBody: "That job doesn't exist, or you can't see it.",
  backToJobs: 'Back to jobs',

  // Stat strip
  statStage: 'Stage',
  statValue: 'Value',
  statDays: 'In this stage',
  daysInStage: (n: number) => (n === 1 ? '1 day' : `${n} days`),

  // Header
  addressLink: (address: string) => `${address} on the map`,
  archivedChip: 'Archived',
  stepperLabel: 'Job stage',
  lostChip: 'Lost',
  lostWhy: (reason: string) => `Lost: ${reason}`,
  repLabel: 'Rep',
  unassigned: 'Unassigned',
  nextStepLabel: 'Next step',
  nextStepNone: 'No next step yet.',
  nextStepOn: (text: string, date: string) => `${text} on ${date}`,
  edit: 'Edit',

  // Edit sheet
  editTitle: 'Edit job',
  valueLabel: 'Job value',
  valueHelp: 'In dollars, like 14,250.',
  valueInvalid: 'Enter an amount in dollars.',
  sourceLabel: 'Source',
  nextStepFieldLabel: 'Next step',
  nextStepFieldHelp: 'Up to 120 characters.',
  nextStepTooLong: 'Keep the next step under 120 characters.',
  nextStepDateLabel: 'Next step date',
  save: 'Save',
  cancel: 'Cancel',
  close: 'Close',
  saved: 'Saved.',
  saveFailed: "We couldn't save that. Try again.",
  archive: 'Archive job',
  restore: 'Restore job',
  archiveConfirm: 'Archive this job? It leaves the board and you can restore it later.',
  restoreConfirm: 'Restore this job to the board?',
  confirm: 'Yes, do it',
  archived: 'Job archived.',
  restored: 'Job restored.',
  archiveFailed: "We couldn't change that. Try again.",

  // Sections
  appointmentsTitle: 'Appointments',
  appointmentsEmpty: 'No appointments yet.',
  bookInspection: 'Book inspection',
  bookInstall: 'Book install',
  appointmentKind: {
    inspection: 'Inspection',
    install: 'Install',
    adjuster: 'Adjuster',
    other: 'Other',
  } as Record<AppointmentKind, string>,
  appointmentLine: (kind: string, when: string, person: string) => `${kind}, ${when}, ${person}`,
  appointmentAllDay: (date: string) => `${date}, all day`,

  quotesTitle: 'Quotes',
  quotesEmpty: 'No quotes yet.',
  newQuote: 'New quote',
  quoteCreateFailed: "We couldn't start a quote. Try again.",
  quoteTotal: (dollars: string) => `Estimate ${dollars}`,
  quoteStatus: {
    draft: 'Draft',
    final: 'Final',
  } as Record<QuoteStatus, string>,

  tasksTitle: 'Agent tasks',
  tasksEmpty: 'No agent tasks for this job.',

  timelineTitle: 'Timeline',
} as const;

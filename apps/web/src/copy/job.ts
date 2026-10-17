import type { AppointmentKind, JobStage, QuoteStatus } from '@roofline/shared';

/** One job's window: header, stage stepper, edit sheet, sections. */
export const job = {
  loading: 'Loading job',
  errorTag: "Couldn't load",
  loadFailed: "We couldn't load this job. Try again in a minute.",
  retry: 'Try again',
  notFoundTitle: 'Not found',
  notFoundBody: "That job doesn't exist, or you can't see it.",
  backToJobs: 'Back to jobs',
  /** The last step of the trail while the job loads. */
  crumbJob: 'Job',

  // The stage steps and the facts under them
  statValue: 'Value',
  daysInStage: (n: number) => (n === 0 ? 'Today' : n === 1 ? '1 day' : `${n} days`),
  /** A stage's name where five of them share a phone's width: only Inspection is too long to sit beside the next one. */
  stageShort: { inspection: 'Insp.' } as Partial<Record<JobStage, string>>,

  // Header
  addressLink: (address: string) => `${address} on the map`,
  /** What follows the street in the line under the name: ", Austin, TX 78701". */
  addressRest: (city: string, state: string, zip: string) => `, ${city}, ${state} ${zip}`,
  /** The whole address, as the directions link carries it. */
  addressFull: (street: string, city: string, state: string, zip: string) => `${street}, ${city}, ${state} ${zip}`,
  archivedChip: 'Archived',
  insuranceClaim: 'Insurance claim',
  actionsLabel: 'Reach the customer and move the job',
  tilesLabel: 'Reach the customer',
  call: 'Call',
  text: 'Text',
  directions: 'Directions',
  stepperLabel: 'Job stage',
  lostChip: 'Lost',
  lostWhy: (reason: string) => `Lost: ${reason}`,
  repLabel: 'Rep',
  unassigned: 'Unassigned',
  nextStepLabel: 'Next step',
  nextStepNone: 'No next step yet.',
  nextStepEmptyBody: 'Write what happens next and when. It shows on the board.',
  nextStepAdd: 'Add a next step',
  /** The line under a next step: when, then who: "Tomorrow · Casey Moreno". */
  nextStepMeta: (parts: readonly string[]) => parts.join(' · '),
  today: 'Today',
  tomorrow: 'Tomorrow',
  overdue: 'Overdue',
  edit: 'Edit',

  // Details panel
  detailsTitle: 'Details',
  customerLabel: 'Customer',
  emailLabel: 'Email',
  sinceLabel: 'In stage since',
  createdLabel: 'Created',

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
  appointmentAllDay: (date: string) => `${date}, all day`,
  appointmentsEmptyBody: 'Book an inspection or an install and it shows here.',

  quotesTitle: 'Quotes',
  quotesEmpty: 'No quotes yet.',
  quotesEmptyBody: 'A quote prices the job line by line. Start one and it shows here.',
  newQuote: 'New quote',
  quoteCreateFailed: "We couldn't start a quote. Try again.",
  quoteTotal: (dollars: string) => `Estimate ${dollars}`,
  quoteStatus: {
    draft: 'Draft',
    final: 'Final',
  } as Record<QuoteStatus, string>,

  proposalsTitle: 'Proposals',
  proposalsEmpty: 'No proposals yet.',
  proposalsEmptyBody: 'Measure the roof, then send a Good, Better and Best proposal.',
  tiersLabel: 'Options in this proposal',
  recommended: 'Recommended',
  /** The tag on a proposal the customer has opened: "Opened 2×". */
  openedTag: (count: number) => `Opened ${count}×`,
  newProposal: 'New proposal',
  proposalStartFailed: "We couldn't start a proposal. Try again.",
  proposalsLoadFailed: "We couldn't load the proposals. Try again.",
  proposalFrom: (money: string) => `Estimate from ${money}`,
  proposalExactFrom: (money: string) => `From ${money}`,

  tasksTitle: 'Agent tasks',
  tasksEmpty: 'No agent tasks for this job.',
  tasksEmptyBody: 'When an agent has something for this job, it shows up here.',

  // Roof panel: what the newest proposal was priced from
  roofTitle: 'Roof',
  roofExact: 'Exact report',
  roofEstimate: 'Estimate',
  roofArea: 'Area',
  roofPitch: 'Main pitch',
  roofOrder: (wastePercent: number) => `Order +${wastePercent}%`,
  roofRidge: 'Ridge and hip',
  roofEdge: 'Eaves',
  roofValley: 'Valleys',
  squares: (n: number) => `${n.toFixed(1)} sq`,
  feet: (n: number) => `${Math.round(n)} ft`,
  pitchValue: (n: number) => `${n}/12`,

  timelineTitle: 'Timeline',
} as const;

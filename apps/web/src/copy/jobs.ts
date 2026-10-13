import type { JobStage } from '@roofline/shared';

/** The Jobs window: tabs, pipeline board, list view, filters, the Move-to menu and sheet. */
export const jobs = {
  comingSoon: 'Your jobs, from lead to paid, are coming soon.',
  viewLabel: 'View jobs',
  boardView: 'Board view',
  listView: 'List view',
  tabsLabel: 'Jobs and customers',
  tabs: { pipeline: 'Pipeline', customers: 'Customers' },

  stage: {
    lead: 'Lead',
    inspection: 'Inspection',
    proposal: 'Proposal',
    won: 'Won',
    installed: 'Installed',
    lost: 'Lost',
  } satisfies Record<JobStage, string>,

  boardLabel: 'Pipeline board',
  listLabel: 'Jobs list',
  columnHeader: (label: string, count: number) => `${label} (${count})`,
  total: (dollars: string) => `${dollars} total`,
  lostDrawer: (count: number) => `Lost (${count})`,
  lostDrawerEmpty: 'No lost jobs.',
  columnEmpty: 'No jobs here yet.',
  showMore: (n: number) => `Show ${n} more`,
  loading: 'Loading jobs',
  loadFailed: "We couldn't load your jobs. Try again in a minute.",
  retry: 'Try again',
  emptyBoard: 'No jobs yet. Add your first job to start your pipeline.',

  // Card text
  value: (dollars: string) => `${dollars}`,
  unassigned: 'Unassigned',
  daysInStage: (n: number) => (n === 1 ? '1 day' : `${n} days`),
  stuck: (n: number) => `Stuck ${n} days`,
  nextStep: (text: string, date: string | null) => (date === null ? `Next: ${text}` : `Next: ${text} on ${date}`),

  // Buttons
  newJob: 'New job',
  downloadJobs: 'Download jobs',

  // Filters
  filtersLabel: 'Filter jobs',
  filterAssignee: 'Assigned to',
  filterAll: 'Everyone',
  filterMine: 'Mine',
  filterUnassigned: 'Unassigned',
  filterSource: 'Source',
  filterSourceAll: 'Any source',
  source: {
    storm: 'Storm',
    call: 'Call',
    text: 'Text',
    web: 'Web',
    referral: 'Referral',
    import: 'Import',
    manual: 'Added by hand',
    front_desk: 'Front Desk',
  },
  filterSearch: 'Search jobs',
  filterSearchHelp: 'Name, address or next step',
  showArchived: 'Show archived',

  // Move to
  moveTo: 'Move to…',
  moveJobFor: (name: string) => `Move ${name}`,
  moved: (stage: string) => `Moved to ${stage}.`,
  moveFailed: "We couldn't move that job. Try again.",

  // Move sheet
  sheetLost: 'Why was the job lost?',
  sheetWon: 'Mark the job Won',
  lostReasonLabel: 'Reason',
  lostReasonPick: 'Pick a reason',
  lostReasons: [
    'Price',
    'Went with another roofer',
    'Insurance denied the claim',
    'No damage found',
    'Stopped responding',
    'Not ready yet',
    'Other',
  ] as const,
  lostReasonOther: 'Other',
  lostReasonOtherLabel: 'What happened?',
  needLostReason: 'Pick why the job was lost.',
  valueLabel: 'Job value',
  valueHelp: 'In dollars',
  needValue: 'Enter the job value to mark it Won.',
  confirm: 'Save',
  cancel: 'Cancel',
  close: 'Close',

  // List view
  listColumns: { job: 'Job', stage: 'Stage', value: 'Value', rep: 'Rep', updated: 'Updated', move: 'Move' },
  listEmpty: 'No jobs match.',
} as const;

export type LostReason = (typeof jobs.lostReasons)[number];

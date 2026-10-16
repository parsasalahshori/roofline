import type { JobStage } from '@roofline/shared';

/** The Jobs page: head, tabs, pipeline board, list view, filters, the Move-to menu and sheet. */
export const jobs = {
  tabsLabel: 'Jobs and customers',
  tabs: { pipeline: 'Pipeline', customers: 'Customers', archived: 'Archived' },

  // The line under the title: real counts only, each part left out when there is nothing to say
  subtitle: {
    open: (n: number) => (n === 1 ? '1 open job' : `${n} open jobs`),
    inPlay: (dollars: string) => `${dollars} in play`,
    waiting: (n: number) => (n === 1 ? '1 proposal waiting on a signature' : `${n} proposals waiting on a signature`),
    archived: (n: number) => (n === 1 ? '1 archived job' : `${n} archived jobs`),
    join: ' · ',
  },
  export: 'Export',
  viewLabel: 'View',
  views: { board: 'Board', list: 'List' },

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
  /** The lane's $ total, with the word a screen reader needs (the page shows only the money). */
  total: (dollars: string) => `${dollars} total`,
  totalWord: 'total',
  /** A lane whose jobs have no value yet: said in words rather than as "$0". */
  noValueYet: 'No value yet',
  /** What the lane's share meter shows, for a screen reader. */
  shareOf: (percent: number) => `${percent}% of the money in play`,
  addToStage: (stage: string) => `Add a job to ${stage}`,
  lostDrawer: (count: number) => `Lost (${count})`,
  lostDrawerEmpty: 'No lost jobs.',
  lostDropHint: 'Drop a job here to mark it lost.',
  lostOpen: 'Lost jobs',
  lostDropHere: 'Drop to mark lost',
  columnEmpty: 'No jobs here yet.',
  dropHere: (stage: string) => `Move to ${stage}`,
  showMore: (n: number) => `Show ${n} more`,
  loading: 'Loading jobs',
  errorTag: "Couldn't load",
  loadFailed: "We couldn't load your jobs. Try again in a minute.",
  retry: 'Try again',
  emptyBoard: 'No jobs yet. Add your first job to start your pipeline.',
  emptyBoardBody: 'Each job moves across the board from Lead to Installed. Drag a card, or use its Move to menu.',
  emptyArchived: 'No archived jobs.',
  emptyArchivedBody: 'A job you archive leaves the board and waits here. Open one to bring it back.',
  emptyFiltered: 'No jobs match.',
  emptyFilteredBody: 'Try a different name, address or filter.',
  clearFilters: 'Clear filters',

  // Card text
  value: (dollars: string) => `${dollars}`,
  unassigned: 'Unassigned',
  daysInStage: (n: number) => (n === 1 ? '1 day' : `${n} days`),
  /** The aging figure on a card: "4d". */
  daysShort: (n: number) => `${n}d`,
  stuck: (n: number) => `Stuck ${n} days`,
  nextStep: (text: string, date: string | null) => (date === null ? `Next: ${text}` : `Next: ${text} on ${date}`),
  /** The next-step line on a card: the step, then when ("today", "Oct 14"). */
  nextStepLine: (text: string, when: string | null) => (when === null ? text : `${text} · ${when}`),
  today: 'today',
  /** The one tag a card can carry, when the job's own dates say so. */
  tagToday: 'Today',
  tagOverdue: 'Overdue',

  // Buttons
  newJob: 'New job',
  downloadJobs: 'Download jobs',
  /** The split button on a hovered card: the next stage, one click away. */
  moveToStage: (stage: string) => `Move to ${stage}`,

  // Filters
  filtersLabel: 'Filter jobs',
  filterAssignee: 'Assigned',
  filterAll: 'Everyone',
  filterMine: 'Mine',
  filterUnassigned: 'Unassigned',
  filterSource: 'Source',
  filterSourceAll: 'Any',
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
  /** Shown in the empty search box. */
  filterSearchPlaceholder: 'Name, address or next step',
  /** What the "/" hint beside the search box does, for a screen reader. */
  filterSearchKey: 'Press the slash key to search',
  showArchived: 'Show archived',

  // Move to
  moveTo: 'Move to…',
  moveJobFor: (name: string) => `Move ${name}`,
  /** The menu's own heading, over the stages: "Move Linda Young to" (set in mono capitals by the kit). */
  moveHeading: (name: string) => `Move ${name} to`,
  moved: (stage: string) => `Moved to ${stage}.`,
  /** The toast after a move, with Undo beside it. */
  movedTo: (name: string, stage: string) => `${name} moved to ${stage}.`,
  archivedJob: (name: string) => `${name} archived.`,
  restoredJob: (name: string) => `${name} restored.`,
  archiveOption: 'Archive',
  restoreOption: 'Restore',
  undo: 'Undo',
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
  listColumns: { job: 'Job', stage: 'Stage', value: 'Value', rep: 'Rep', age: 'Age', updated: 'Updated', move: 'Move' },
  listEmpty: 'No jobs match.',
  listSection: (stage: string, count: number) => `${stage}, ${count}`,
} as const;

export type LostReason = (typeof jobs.lostReasons)[number];

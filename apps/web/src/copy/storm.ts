import type { TaskStatus } from '@roofline/shared';

/** The Storm window. Never name a vendor here: the ad accounts are named in copy/connections.ts. */
export const storm = {
  /** The name of the card that offers the newest storm plan. */
  planHeading: 'A storm plan is ready for you',

  /** Storm window. */
  loading: 'Loading your storms',
  listHeading: 'Storms in your area',
  empty: 'No hail in your area in the last 30 days. We check every 30 minutes.',
  loadFailed: 'We could not load your storms. Try again in a minute.',
  staleBanner: 'Hail data is a little behind',
  radarEstimated: 'Radar-estimated',
  /** 'Up to 1.75" (radar-estimated)' */
  upTo: (inches: string) => `Up to ${inches}" (radar-estimated)`,
  customersHit: (n: number) => (n === 1 ? '1 customer hit' : `${n} customers hit`),
  homesHit: (n: number) => (n === 1 ? '1 home hit' : `${n} homes hit`),
  customersHitLabel: 'Customers hit',
  homesHitLabel: 'Homes hit',
  seePlan: 'See plan',
  viewStorm: 'See this storm',
  planStatus: {
    draft: 'Plan waiting for your OK',
    awaiting_owner: 'Plan waiting for your OK',
    approved: 'Plan approved',
    declined: 'Plan declined',
    expired: 'Plan expired',
    running: 'Plan running',
    done: 'Plan finished',
    partly_done: 'Plan partly done',
    needs_attention: 'Plan needs attention',
  } satisfies Record<TaskStatus, string>,
  noPlan: 'No plan yet',
  dismissed: 'Dismissed',

  /** The storms table: heads, the count beside the title, and the card that stands in when no plan waits. */
  count: (n: number) => (n === 1 ? '1 storm' : `${n} storms`),
  colStorm: 'Storm',
  colHail: 'Hail',
  colCustomers: 'Customers hit',
  colHomes: 'Homes hit',
  colPlan: 'Plan',
  colActions: 'Actions',
  hailUnit: 'in',
  radarNote: 'Hail sizes are estimated from radar.',
  noPlanWaiting: 'No storm plan is waiting for you',
  noPlanWaitingHelp: 'When hail crosses your area, Storm Scout drafts a plan here for your OK.',
  /** The name of the card with the swaths while the Storm page is open. */
  mapPanelLabel: 'Hail in your area',

  /** Storm detail. */
  detailHeading: 'Storm details',
  crumbStorm: 'Storm',
  hailSizeLabel: 'Hail size',
  /** The word under the size in the strip: how big that is in a hand, then where the number comes from. */
  hailSizeMeta: (name: string) => `${name} · from radar`,
  /** Under the customers and homes hit: where they are. */
  insideSwath: 'Inside the swath',
  planPanelTitle: 'The plan',
  planPanelNone: 'No plan has been made for this storm yet.',
  planPanelWaiting: 'Storm Scout drafted a plan. It sends nothing until you say yes.',
  planPanelRunning: 'The plan is running. The numbers below update every minute.',
  planPanelDone: 'The plan has run.',
  planPanelOver: 'The last plan is over. You can draft a new one.',
  notFound: 'We could not find that storm.',
  mapLabel: 'Map of where hail fell (radar-estimated)',
  planHeadingDetail: 'The plan',
  openPlan: 'Open the plan',
  redraft: 'Draft a new plan',
  redrafting: 'Drafting...',
  dismiss: 'Dismiss this storm',
  dismissConfirmTitle: 'Dismiss this storm?',
  dismissConfirmBody: 'It leaves your list and no plan is made for it.',
  dismissConfirm: 'Yes, dismiss it',
  dismissCancel: 'Keep it',

  /** Results. */
  resultsHeading: 'Results so far',
  resultsEmpty: 'Results show up here once the plan runs.',
  textsSent: 'Texts sent',
  textsDelivered: 'Texts delivered',
  replies: 'Replies',
  yesReplies: 'YES replies',
  emailsSent: 'Emails sent',
  unsubscribes: 'Unsubscribes',
  doorsKnocked: 'Doors knocked',
  wantsCheck: 'Want a check',
  adSpendLabel: 'Ad spend',
  /** Under the spend: the most the ads may cost. */
  adSpendOf: (max: string) => `of ${max} budget`,
  adClicks: 'Ad clicks',
  landingRequests: 'Landing page requests',
  inspectionsBooked: 'Inspections booked',

  /** The Storm tab in Settings (owner and office). */
  settings: {
    loading: 'Loading your storm settings',
    save: 'Save',
    saved: 'Storm settings saved.',

    thresholdHeading: 'When a storm starts a plan',
    thresholdLabel: 'Hail size that starts a plan',
    thresholdHelp: 'Radar-estimated hail at or above this size starts a storm plan.',
    thresholdOption: (inches: number) => `${inches.toFixed(2)} inches`,

    budgetHeading: 'Ad budget for a storm',
    budgetLabel: 'Budget in dollars',
    budgetHelp: 'The most the ads may spend for one storm.',
    budgetInvalid: 'Please enter the budget as a dollar amount, such as 300.',
    daysLabel: 'Days the ads run',
    daysHelp: 'Whole days, from 1 to 30.',
    daysInvalid: 'Please enter the days as a whole number.',
    shareHelp: 'Drag to split the budget between the two ad accounts.',

    emailsHeading: 'Storm emails',
    emailsLabel: 'Send storm emails',
    emailsHelp: 'Turn this off to stop storm emails for this company.',

    templatesHeading: 'Storm messages',
    templatesHelp: 'The texts and emails sent after a storm. Each one fills in with the person it goes to.',
    tokensHelp: 'Words that fill in: {first_name}, {company}, {hail_size}, {street}, {day}, {company_address}, {unsubscribe}.',
    smsLabel: 'Text message',
    smsHelp: 'Keep {company} and Reply STOP so people can opt out.',
    emailSubjectLabel: 'Email subject',
    emailLabel: 'Email message',
    emailHelp: 'Keep {company}, {company_address} and {unsubscribe} so people can unsubscribe.',
    useStandardText: 'Use the standard text',
    useStandardTextFor: (name: string) => `Use the standard text for ${name}`,
    missingTokens: (list: string) => `This message is missing ${list}. Add it before you save.`,

    photosHeading: 'Ad photos',
    photosHelp: 'JPEG or PNG, up to 5 MB each. Shown with the storm ads.',
    photosEmpty: 'No photos yet.',
    photosFull: (max: number) => `You have the most photos allowed, ${max}. Remove one to add another.`,
    photoPickLabel: 'Add a photo',
    photoChoose: 'Choose a photo',
    photoDrop: 'Or drop a photo here',
    photoType: 'Photos must be a JPEG or PNG.',
    photoSize: 'Photos must be 5 MB or smaller.',
    photoAlt: (n: number) => `Ad photo ${n}`,
    removePhoto: (n: number) => `Remove ad photo ${n}`,
    remove: 'Remove',
  },
} as const;

/** The ad error sentences name the ad platforms, so they live in connections.ts. */
export { adErrorCopy } from './connections.ts';

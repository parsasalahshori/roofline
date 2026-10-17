/** The Home page: the greeting, the numbers strip, the storm callout on the map, the approval card, today's visits and what the agents did. */

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

export const home = {
  /** "Good morning, Dana." */
  greeting: (part: 'morning' | 'afternoon' | 'evening', firstName: string) =>
    firstName ? `Good ${part}, ${firstName}.` : `Good ${part}.`,
  measureAddress: 'Measure an address',
  newJob: 'New job',

  // The numbers strip
  kpisLabel: 'Your numbers',
  kpiLoadFailed: 'Could not load this',
  signed: 'Signed this month',
  /** The line under the signed total when the company has a goal: "62% of the $25,000 goal". */
  signedGoal: (percent: number, goal: string) => `${percent}% of the ${goal} goal`,
  /** Under the signed total, beside the weekly bars. */
  signedMeta: 'Weekly, last 12 weeks',
  signedNothing: 'Nothing signed yet this month',
  signedWeeks: 'Signed each week, last 12 weeks',
  pipeline: 'Open pipeline',
  pipelineMeta: (openJobs: number, atProposal: number) =>
    `${openJobs} open ${plural(openJobs, 'job', 'jobs')} · ${atProposal} at proposal`,
  /** "Hail · Monday", or just "Hail" when the company has had none. */
  hail: (day: string | null) => (day === null ? 'Hail' : `Hail · ${day}`),
  hailUnit: 'in',
  hailNone: 'None',
  hailNoneMeta: 'No hail in the last 30 days',
  /** The words after the bold count: "34 customers inside the swath". */
  hailInside: (customers: number) => `${plural(customers, 'customer', 'customers')} inside the swath`,
  desk: 'Front Desk · this week',
  deskUnit: 'calls',
  deskMeta: (booked: number, passedOn: number) =>
    `${booked} ${plural(booked, 'inspection', 'inspections')} booked${passedOn > 0 ? ` · ${passedOn} passed to your team` : ''}`,

  // The storm callout over the map
  stormRegion: 'The latest storm',
  /** The weekday slot of "Hail · Monday" when the storm was yesterday (today reads "Today", from the forecast copy). */
  yesterday: 'Yesterday',
  /** "today", "yesterday", "on Monday" or "on Oct 9": when the storm crossed. */
  stormWhen: (kind: 'today' | 'yesterday' | 'day', label: string) =>
    kind === 'today' ? 'today' : kind === 'yesterday' ? 'yesterday' : `on ${label}`,
  stormTitle: (inches: string, place: string | null, when: string) => `Hail up to ${inches} in crossed ${place ?? 'your area'} ${when}`,
  stormBody: (customers: number, homes: number, plan: string) =>
    `${customers} ${plural(customers, 'customer', 'customers')} and ${homes.toLocaleString('en-US')} ${plural(homes, 'home', 'homes')} inside. ${plan}`,
  /** The plan's state, as the last sentence of the callout. Keyed by the plan's status; none is "No plan yet". */
  stormPlan: {
    draft: 'Storm Scout drafted a plan.',
    awaiting_owner: 'Storm Scout drafted a plan.',
    approved: 'The plan is on its way.',
    running: 'The plan is running.',
    done: 'The plan finished.',
    partly_done: 'The plan partly finished.',
    needs_attention: 'The plan needs a look.',
    declined: 'The plan was set aside.',
    expired: 'The plan expired.',
  } as Record<string, string>,
  stormNoPlan: 'No plan yet.',
  openStormReport: 'Open storm report',
  stormDismiss: 'Dismiss the storm note',

  // The line under the approval card (the card itself is the Need your OK page's, with its words in copy/approvals.ts)
  moreWaiting: (count: number) => `${count} more ${plural(count, 'plan needs', 'plans need')} your OK`,
  seeAll: 'See all',

  // Today's visits
  todayTitle: 'Today',
  visits: (count: number) => `${count} ${plural(count, 'visit', 'visits')}`,
  calendar: 'Calendar',
  visitsLabel: "Today's visits",
  allDay: 'All day',
  /** "Roof install · Richard Jackson" */
  visitTitle: (kind: string, who: string) => `${kind} · ${who}`,
  /** Address and the like, side by side: "4265 Harney St · from Front Desk" */
  visitDetail: (parts: readonly string[]) => parts.join(' · '),
  fromFrontDesk: 'from Front Desk',
  noVisits: 'No visits today',
  noVisitsLeads: (leads: number) =>
    `${leads} ${plural(leads, 'lead has', 'leads have')} no inspection yet. A visit booked now shows up here.`,
  noVisitsHelp: 'A visit you book shows up here, with the time, the address and who goes.',
  bookVisit: 'Book a visit',
  visitsFailed: 'Could not load today’s visits.',

  // What your AI did
  aiTitle: 'What your AI did',
  agentsLink: 'Agents',
} as const;

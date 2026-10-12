/** The Storm window. */
export const storm = {
  /** The name of the card that offers the newest storm plan. */
  planHeading: "A storm plan is ready for you",
  approve: "Approve storm plan",
  /** The storm page, until the storm detail is built. */
  /** The Storm tab in Settings, until it is built. */
  settingsComingSoon: "Your storm settings are on their way.",

  /** Storm window. */
  listHeading: "Storms in your area",
  empty: "No hail in your area in the last 30 days. We check every 30 minutes.",
  loadFailed: "We could not load your storms. Try again in a minute.",
  staleBanner: "Hail data is a little behind",
  radarEstimated: "Radar-estimated",
  /** "Up to 1.75" Radar-estimated" */
  upTo: (inches: string) => `Up to ${inches}" (radar-estimated)`,
  customersHit: (n: number) =>
    n === 1 ? "1 customer hit" : `${n} customers hit`,
  homesHit: (n: number) => (n === 1 ? "1 home hit" : `${n} homes hit`),
  seePlan: "See plan",
  viewStorm: "See this storm",
  planStatus: {
    draft: "Plan waiting for your OK",
    awaiting_owner: "Plan waiting for your OK",
    running: "Plan running",
    done: "Plan finished",
  } as Record<string, string>,
  noPlan: "No plan yet",
  dismissed: "Dismissed",

  /** Storm detail. */
  detailHeading: "Storm details",
  notFound: "We could not find that storm.",
  mapLabel: "Map of where hail fell (radar-estimated)",
  legendHeading: "Radar-estimated hail",
  legendLevel: (inches: string) => `${inches}" or more`,
  planHeadingDetail: "The plan",
  openPlan: "Open the plan",
  redraft: "Draft a new plan",
  redrafting: "Drafting...",
  dismiss: "Dismiss this storm",
  dismissConfirmTitle: "Dismiss this storm?",
  dismissConfirmBody: "It leaves your list and no plan is made for it.",
  dismissConfirm: "Yes, dismiss it",
  dismissCancel: "Keep it",

  /** Results. */
  resultsHeading: "Results so far",
  resultsEmpty: "Results show up here once the plan runs.",
  textsSent: "Texts sent",
  textsDelivered: "Texts delivered",
  replies: "Replies",
  yesReplies: "YES replies",
  emailsSent: "Emails sent",
  unsubscribes: "Unsubscribes",
  doorsKnocked: "Doors knocked",
  wantsCheck: "Want a check",
  adSpend: (spent: string, max: string) => `Ad spend ${spent} of ${max}`,
  adClicks: "Ad clicks",
  landingRequests: "Landing page requests",
  inspectionsBooked: "Inspections booked",
} as const;

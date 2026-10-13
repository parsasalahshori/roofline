/** Settings, Billing: the plan and the payments; and the banners under the top bar. Card payments run through Stripe. */
export const billing = {
  noPlan: 'No plan yet',
  trialUntil: (date: string) => `Free trial until ${date}`,
  statusLabel: {
    trial: 'Free trial',
    active: 'Active',
    pastDue: "Payment didn't go through",
    trialEnded: 'Trial ended',
    canceled: 'Canceled',
  },
  usageHeading: 'Usage this period',
  plansHeading: 'Plans',
  meterLabel: { smsSegment: 'Text segments', aiCallMinute: 'AI call minutes' },
  usedOf: (used: number, included: number, meter: 'smsSegment' | 'aiCallMinute') =>
    `${used} of ${included} ${meter === 'smsSegment' ? 'text segments' : 'AI call minutes'}`,
  usedSoFar: (used: number) => `${used} so far`,
  perMonth: (cents: number) =>
    `${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100)}/month`,
  includes: (aiMinutes: number, smsSegments: number) =>
    `Includes ${new Intl.NumberFormat('en-US').format(aiMinutes)} AI call minutes and ${new Intl.NumberFormat('en-US').format(smsSegments)} text segments`,
  pickPlan: 'Pick this plan',
  switchPlan: 'Switch to this plan',
  yourPlan: 'Your plan',
  invoicesAndCard: 'Invoices and card',
  cardNote: 'Card payments run through Stripe.',
  thanks: 'Thanks! Your plan is set up.',
  planChangeRequested: 'Your plan change is on its way.',
  ownerOnly: 'Only the owner can see billing.',
  banners: {
    trialEnded: 'Your free trial has ended. Your data is safe and you can still look around.',
    canceled: 'Your plan was canceled. Your data is safe and you can still look around.',
    pickPlan: 'Pick a plan to keep going',
    pastDue: "Your payment didn't go through. Texts and calls are paused until it's fixed.",
    fixPayment: 'Fix payment',
    askOwner: 'Ask your owner to update the card.',
  },
} as const;

/** Paid one-off reports, named by who supplies them (spend: each goes through an approval). */
export const paidReports = {
  exactChoice: 'Order EagleView report',
  exactRequest: 'Request EagleView report',
} as const;

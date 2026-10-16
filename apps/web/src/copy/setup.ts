import type { ComingWith, SetupItemKey } from '@roofline/shared';

/** Settings, Setup: the checklist for getting a company started. */
export type SetupItemCopy = { title: string; description: string; unlocks?: string };

/** Copy per checklist key; the keys are code only, never shown. */
export const setupItems: Record<SetupItemKey, SetupItemCopy> = {
  company_basics: { title: 'Your company on the map', description: 'Your name, address and the area you work in.' },
  import_customers: {
    title: 'Bring in your customers',
    description: 'Upload a spreadsheet from your old system.',
    unlocks: 'Unlocks storm texts to your existing customers',
  },
  texting_registration: {
    title: 'Register for texting',
    description: 'Phone carriers approve your business before you can text customers.',
    unlocks: 'Unlocks all texting',
  },
  invite_team: { title: 'Invite your team', description: 'Add your office staff and reps.' },
  payment_method: {
    title: 'Add a card',
    description: 'Needed before anything that costs money, like texting. Card payments run through Stripe.',
    unlocks: 'Unlocks texting registration and exact roof reports',
  },
  prices_and_tiers: { title: 'Prices and Good/Better/Best', description: 'Your pricebook for estimates.', unlocks: 'Unlocks the Estimator' },
  connect_calendar: {
    title: 'Connect your calendar',
    description: 'Google or Outlook, so bookings land on your calendar.',
    unlocks: 'Unlocks Front Desk booking',
  },
  phone_number: {
    title: 'Your Roofline phone number',
    description: 'Forward your business line so every call is answered.',
    unlocks: 'Unlocks Front Desk',
  },
  connect_ads: {
    title: 'Connect your ad accounts',
    description: 'Link Google Ads and share your Meta ad account.',
    unlocks: 'Unlocks storm ads',
  },
};

export const comingWith: Record<ComingWith, string> = {
  estimator: 'Coming with the Estimator',
  calendar: 'Calendar',
  front_desk: 'Coming with Front Desk',
  storm_scout: 'Coming with Storm Scout',
};

export const setup = {
  listLabel: 'Setup steps',
  progress: (done: number, total: number) => `${done} of ${total} setup steps done`,
  ringLabel: (done: number, total: number) => `${done} of ${total} setup steps done`,
  ownerNote: 'Your owner finishes setup.',
  chips: {
    todo: 'To do',
    in_progress: 'Started',
    done: 'Done',
    skipped: 'Skipped',
    waiting: 'Waiting on phone carriers (usually 10–15 days)',
    rejected: 'Needs a fix',
  },
  actions: {
    checkDetails: 'Check details',
    importCustomers: 'Import customers',
    start: 'Start',
    fixAndResubmit: 'Fix and resubmit',
    invite: 'Invite',
    addCard: 'Add a card',
    setPrices: 'Set prices',
    forwardCalls: 'Forward your calls',
    skip: 'Skip for now',
    undoSkip: 'Undo skip',
    connectCalendar: 'Connect your calendar',
    connectAds: 'Connect ad accounts',
  },
  sheet: {
    title: 'Your company on the map',
    close: 'Close',
    placeOnMap: 'Place on map',
    radiusLabel: 'Area you work in',
    editDetails: 'Edit company details',
    placed: 'Your company is on the map.',
  },
  radius: (miles: number) => `${miles} miles`,
  loadFailed: "Couldn't load your setup steps.",
} as const;

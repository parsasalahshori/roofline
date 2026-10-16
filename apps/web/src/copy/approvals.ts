/** The approvals queue, and what the review screen says when a plan is set aside. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

/** The calendar day a time falls on, in the browser's own time zone. Two times on the same day share the key. */
const dayKey = (time: number): string => {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export const approvals = {
  /** The toast after "Not now" went through. */
  declined: "Okay, we've set this plan aside.",
  /** The toast after a plan was approved from the queue; its button opens the plan to watch it run. */
  approved: (title: string): string => `Approved: ${title}`,
  seeProgress: 'See progress',
  emptyTitle: 'Nothing needs your OK.',
  emptyBody: 'When an agent drafts a plan, it waits here for a yes: its steps, what it costs and who it reaches.',
  emptyAction: 'See what your agents did',
  emptyHref: '/agents/feed',
  repTitle: 'Approvals are for owners and office staff.',
  repBody: 'Plans your agents draft are approved by the owner or the office. You can see your own day in My day.',
  repAction: 'Open My day',
  repHref: '/today',
  /** Replaces the status on a list row whose plan ran out of time. */
  expired: 'Expired',
  /** The heading over the plans that ran out of time before anyone answered. */
  expiredTitle: 'Ran out of time',
  expiredOpen: 'Open',
  /** The accessible name of the list of plans. */
  listLabel: 'Plans waiting for your OK',
  /** The accessible name of the list of plans that expired. */
  expiredListLabel: 'Plans that expired',
  loading: 'Loading the plans waiting for your OK',
  /** The red tag over a list that could not be loaded. */
  errorTag: "Couldn't load",
  /** The tag on a card: what the card is asking for. */
  tagNeedsOk: 'Needs your OK',
  tagWaitingOwner: 'Waiting for owner',
  /** "Storm Scout drafted · 3 days ago". */
  drafted: (agent: string, ago: string): string => `${agent} drafted · ${ago}`,
  /** How long ago, in words: "just now", "12 min ago", "3 hr ago", "2 days ago". */
  ago: (iso: string, now: number): string => {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return '';
    const ms = Math.max(0, now - then);
    if (ms < MINUTE) return 'just now';
    if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
    if (ms < DAY) return `${Math.floor(ms / HOUR)} hr ago`;
    return `${plural(Math.floor(ms / DAY), 'day', 'days')} ago`;
  },
  /** The line at the right of a card's buttons: "Expires Sat". Nothing when the plan has no end time. */
  expires: (iso: string | null, now: number): string | undefined => {
    if (iso === null) return undefined;
    const end = Date.parse(iso);
    if (Number.isNaN(end) || end <= now) return undefined;
    const ms = end - now;
    if (ms < HOUR) return `Expires in ${Math.max(1, Math.ceil(ms / MINUTE))} min`;
    if (dayKey(end) === dayKey(now)) return 'Expires today';
    if (dayKey(end) === dayKey(now + DAY)) return 'Expires tomorrow';
    if (ms < 6 * DAY) return `Expires ${weekday.format(end)}`;
    return `Expires ${monthDay.format(end)}`;
  },
  approve: 'Approve',
  edit: 'Edit',
  later: 'Not now',
  /** The main button of a plan with more than one step to decide: it opens the review screen. */
  reviewSteps: (n: number): string => `Review ${plural(n, 'step', 'steps')}`,
  /** The main button of a plan this person has nothing left to decide on. */
  reviewPlan: 'Open plan',
  /** The name a screen reader hears for a locked fact's lock. */
  locked: 'Locked: it cannot be changed here',
  // The facts on a card. What the API does not say is left out, never guessed.
  factSteps: 'Steps',
  factRecipients: 'Recipients',
  factSends: 'Sends',
  factCost: 'Cost',
  stepsValue: (n: number): string => `${n}`,
  textsValue: (n: number): string => plural(n, 'text', 'texts'),
  emailsValue: (n: number): string => plural(n, 'email', 'emails'),
  customersValue: (n: number): string => plural(n, 'customer', 'customers'),
  /** The keys of the queue, in the strip over it. */
  keysLabel: 'Keyboard shortcuts',
  keys: [
    { keys: ['J', 'K'], label: 'next or previous plan' },
    { keys: ['1'], label: 'approve' },
    { keys: ['E'], label: 'edit' },
    { keys: ['H'], label: 'not now' },
  ],
} as const;

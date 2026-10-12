import { z } from 'zod';

/**
 * The values behind each G1 agent rule (spec 6, `company_settings`; spec 7, Settings → Agents).
 * The bounds are the database CHECKs; these are the plain-English versions the API and the form share.
 */
export type AgentValues = {
  claimsNudgeDays: [number, number, number];
  weatherRainPct: number;
  weatherGustMph: number;
  reminderHour: number;
  followupDays: [number, number];
  leadFollowupDays: number;
  reviewLink: string | null;
  reviewDelayDays: number;
  followupReviews: boolean;
  followupLeads: boolean;
  followupProposals: boolean;
};

export const AGENT_VALUE_MESSAGES = {
  percent: 'Please enter a percent from 0 to 100.',
  gust: 'Please enter a whole number of miles per hour from 1 to 100.',
  hour: 'Please pick an hour from 0 to 23.',
  nudgeDays: 'Please enter three whole numbers of days from 1 to 60.',
  followupDays: 'Please enter two whole numbers of days from 1 to 30.',
  leadDays: 'Please enter a whole number of days from 1 to 30.',
  reviewDelay: 'Please enter a whole number of days from 0 to 30.',
  reviewLink: 'Please enter a web address that starts with https://',
  reviewLinkLength: 'Please keep the review link to 200 characters or fewer.',
} as const;

/** Short enough that a review request with the link always fits one personal text (480 characters). */
const MAX_REVIEW_LINK = 200;

const wholeNumber = (min: number, max: number, message: string) =>
  z.number({ error: message }).int(message).min(min, message).max(max, message);

/** True when the (trimmed) text is an https:// web address with a dotted host. */
function isHttpsLink(text: string): boolean {
  if (!text.startsWith('https://')) return false;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname.includes('.');
  } catch {
    return false;
  }
}

const NUDGE_DAY = wholeNumber(1, 60, AGENT_VALUE_MESSAGES.nudgeDays);

const shape = {
  claimsNudgeDays: z
    .tuple([NUDGE_DAY, NUDGE_DAY, NUDGE_DAY], { error: AGENT_VALUE_MESSAGES.nudgeDays })
    .optional(),
  weatherRainPct: wholeNumber(0, 100, AGENT_VALUE_MESSAGES.percent).optional(),
  weatherGustMph: wholeNumber(1, 100, AGENT_VALUE_MESSAGES.gust).optional(),
  reminderHour: wholeNumber(0, 23, AGENT_VALUE_MESSAGES.hour).optional(),
  followupDays: z
    .tuple(
      [wholeNumber(1, 30, AGENT_VALUE_MESSAGES.followupDays), wholeNumber(1, 30, AGENT_VALUE_MESSAGES.followupDays)],
      { error: AGENT_VALUE_MESSAGES.followupDays },
    )
    .optional(),
  leadFollowupDays: wholeNumber(1, 30, AGENT_VALUE_MESSAGES.leadDays).optional(),
  // An empty string means "no link": it is stored as null.
  reviewLink: z
    .string({ error: AGENT_VALUE_MESSAGES.reviewLink })
    .trim()
    .max(MAX_REVIEW_LINK, AGENT_VALUE_MESSAGES.reviewLinkLength)
    .refine((v) => v === '' || isHttpsLink(v), AGENT_VALUE_MESSAGES.reviewLink)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  reviewDelayDays: wholeNumber(0, 30, AGENT_VALUE_MESSAGES.reviewDelay).optional(),
  followupReviews: z.boolean({ error: 'Please choose yes or no.' }).optional(),
  followupLeads: z.boolean({ error: 'Please choose yes or no.' }).optional(),
  followupProposals: z.boolean({ error: 'Please choose yes or no.' }).optional(),
};

/** Every field an agent-values PATCH may carry. Anything else is refused, not ignored. */
export const AGENT_VALUE_FIELDS = Object.keys(shape) as readonly (keyof AgentValues)[];

/** A PATCH of the agent values: each field optional, unknown keys refused. */
export const AgentValuesPatch: z.ZodType<Partial<AgentValues>> = z.strictObject(shape);

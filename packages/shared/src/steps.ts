import { z } from 'zod';
import type { ApprovalClass } from './enums.ts';
import { MESSAGE_PURPOSES } from './enums.ts';
import { renderBody } from './render.ts';
import { AD_PLATFORMS, dailyBudgetCents, renderStormTemplate } from './storm.ts';
import { MAX_DOORS_PER_PLAN, MAX_DOORS_PER_ROUTE } from './door-routes.ts';
import { MEASUREMENT_KINDS, TIERS, type MeasurementKind, type Tier } from './proposals.ts';

/*
 * The step-type registry (spec 4.1): what each kind of step an agent can put in a task needs, in
 * one place. For a step type it says
 * - which approval a person needs to give for it (`approvalClass`: the agent never chooses),
 * - what its payload must look like (`payload`, a zod schema with plain-English messages) and any
 *   rule that needs more than the shape (`validate`, today only the marketing-text rule),
 * - what the review screen shows (`preview`), and
 * - how many minutes of staff time it saved once it ran (`minutesSaved`).
 * The API builds previews and checks payloads from here, and the runner adds up `minutesSaved`.
 */

export const STEP_TYPES = [
  'demo_noop',
  'demo_message',
  'demo_spend',
  'send_sms_batch',
  'send_email_batch',
  'build_routes',
  'create_ad_campaign',
  'send_proposal',
  'order_exact_report',
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export function isStepType(value: unknown): value is StepType {
  return typeof value === 'string' && (STEP_TYPES as readonly string[]).includes(value);
}

/** What a preview can be built from besides the payload itself. The API looks these up; the registry never does. */
export type PreviewFacts = { companyName: string; recipientCount?: number; sampleFirstName?: string; companyAddress?: string };

/** What the review screen shows for one step. */
export type StepPreview = {
  title: string;
  lines: string[];
  messageSample?: string;
  recipientCount?: number;
  sendTime?: string;
  maxSpendCents?: number;
};

/** What a step reports when it has run: counts such as `{ sent: 31, blocked: 2 }`, or counts by name. */
export type StepResult = Record<string, number | Record<string, number>>;

export interface StepTypeDef<P> {
  type: StepType;
  approvalClass: ApprovalClass;
  payload: z.ZodType<P>;
  /** A rule the shape cannot say. Returns the sentence to show a person, or null when the payload is fine. */
  validate?(p: P, facts: { companyName: string }): string | null;
  preview(p: P, facts: PreviewFacts): StepPreview;
  minutesSaved(p: P, result: StepResult): number;
  /**
   * Ruling AY (A1's step shape, ahead of the a1-agents merge, which drops `minutesSaved` and makes
   * these required): whether a person may create the step by hand, the time-saved baseline it counts
   * against (A1's TIME_BASELINES key) and how many units of it the finished step did.
   */
  userCreatable?: boolean;
  baseline?(p: P, result: StepResult): StormBaselineKey;
  units?(p: P, result: StepResult): number;
}

/** The A1 TIME_BASELINES keys the storm steps count against (A1: 0.5 min an email capped at 120, 45 min a route, 45 min a campaign). */
export type StormBaselineKey = 'email_sent' | 'route_built' | 'ad_campaign';

/** A count from a step's result: a finite number above zero, else 0. */
function resultCount(value: StepResult[string] | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

// ---------------------------------------------------------------------------------------------
// Pieces the payload schemas share

/** Postgres cannot store a NUL character in text (a jsonb value included), so one is refused up front instead of becoming a 500. */
const noNul = (value: string): boolean => !value.includes('\0');
const CHECK_TEXT = 'Please check this text.';

const LABEL_MESSAGE = 'Please enter a label.';
const label = z
  .string({ error: LABEL_MESSAGE })
  .trim()
  .min(1, LABEL_MESSAGE)
  .max(200, 'Please keep the label to 200 characters or fewer.')
  .refine(noNul, CHECK_TEXT);

const SPEND_MESSAGE = 'Please enter the most to spend, in cents, as a whole number.';
/** The largest value a 32-bit integer holds, which is also far more than any one step may spend. */
const MAX_SPEND_CENTS = 2_147_483_647;
const maxSpendCents = z
  .number({ error: SPEND_MESSAGE })
  .int(SPEND_MESSAGE)
  .min(0, SPEND_MESSAGE)
  .max(MAX_SPEND_CENTS, SPEND_MESSAGE);

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const wholeDollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------
// Demo steps (the 3-step demo task of F2, and the tests)

const labelPayload = z.strictObject({ label });
type LabelPayload = z.output<typeof labelPayload>;

const demoNoop: StepTypeDef<LabelPayload> = {
  type: 'demo_noop',
  approvalClass: 'internal',
  payload: labelPayload,
  preview: (p) => ({ title: p.label, lines: [] }),
  minutesSaved: () => 5,
};

/** A demo text's optional details: the sample message, how many customers, and when it goes out. */
const COUNT_MESSAGE = 'Please enter the number of customers as a whole number.';
const messagePayload = z.strictObject({
  label,
  sample: z
    .string({ error: CHECK_TEXT })
    .trim()
    .max(640, 'Please keep the sample to 640 characters or fewer.')
    .refine(noNul, CHECK_TEXT)
    .optional(),
  recipientCount: z.number({ error: COUNT_MESSAGE }).int(COUNT_MESSAGE).min(0, COUNT_MESSAGE).optional(),
  sendTime: z
    .string({ error: CHECK_TEXT })
    .trim()
    .max(60, 'Please keep the send time to 60 characters or fewer.')
    .refine(noNul, CHECK_TEXT)
    .optional(),
});
type MessagePayload = z.output<typeof messagePayload>;

const demoMessage: StepTypeDef<MessagePayload> = {
  type: 'demo_message',
  approvalClass: 'message',
  payload: messagePayload,
  preview: (p) => ({
    title: p.label,
    lines: [],
    ...(p.sample !== undefined && { messageSample: p.sample }),
    ...(p.recipientCount !== undefined && { recipientCount: p.recipientCount }),
    ...(p.sendTime !== undefined && { sendTime: p.sendTime }),
  }),
  minutesSaved: () => 5,
};

/** A demo spend step's optional area, which the preview shows after the spend line. */
const spendPayload = z.strictObject({
  label,
  maxSpendCents,
  area: z
    .string({ error: CHECK_TEXT })
    .trim()
    .max(120, 'Please keep the area to 120 characters or fewer.')
    .refine(noNul, CHECK_TEXT)
    .optional(),
});
type SpendPayload = z.output<typeof spendPayload>;

const demoSpend: StepTypeDef<SpendPayload> = {
  type: 'demo_spend',
  approvalClass: 'spend',
  payload: spendPayload,
  preview: (p) => ({
    title: p.label,
    lines: [`Spends up to ${dollars.format(p.maxSpendCents / 100)}`, ...(p.area !== undefined ? [p.area] : [])],
    maxSpendCents: p.maxSpendCents,
  }),
  minutesSaved: () => 5,
};

// ---------------------------------------------------------------------------------------------
// send_sms_batch

export const MARKETING_TEXT_MESSAGE = 'Marketing texts must include your company name and "Reply STOP to opt out".';

const WRITE_MESSAGE = 'Please write the message.';
const PICK_CUSTOMERS = 'Please pick customers from your list.';

/**
 * Per-customer details for a batch (spec 4.5): the values a template reads, keyed by customer id.
 * Each value is at most 60 characters, and a batch holds at most 5,000 customers.
 */
const FIELDS_MESSAGE = 'Please check the details for each customer.';
const fieldsMap = z
  .record(
    z.string(),
    z.record(
      z.string(),
      z
        .string({ error: FIELDS_MESSAGE })
        .max(60, 'Please keep each detail to 60 characters or fewer.')
        .refine(noNul, CHECK_TEXT),
    ),
  )
  .refine((fields) => Object.keys(fields).length <= 5000, 'You can fill in details for at most 5,000 customers.');

const smsPayload = z.strictObject({
  purpose: z.enum(MESSAGE_PURPOSES, { error: 'Please pick marketing or informational.' }),
  body: z
    .string({ error: WRITE_MESSAGE })
    .trim()
    .min(1, WRITE_MESSAGE)
    .max(1000, 'Please keep the message to 1,000 characters or fewer.')
    .refine(noNul, CHECK_TEXT),
  customerIds: z
    .array(
      z.uuid({ error: PICK_CUSTOMERS }).transform((id) => id.toLowerCase()),
      { error: PICK_CUSTOMERS },
    )
    .min(1, 'Please pick at least one customer.')
    .max(5000, 'You can text at most 5,000 customers in one go.')
    .refine((ids) => new Set(ids).size === ids.length, 'Each customer can only be listed once.'),
  /** The start of the dedupe key the texts carry (for example `storm:<id>`), so the same message is not sent twice. */
  dedupePrefix: z
    .string({ error: CHECK_TEXT })
    .trim()
    .min(1, CHECK_TEXT)
    .max(100, 'Please keep that to 100 characters or fewer.')
    .refine(noNul, CHECK_TEXT)
    .optional(),
  fields: fieldsMap.optional(),
});
type SmsPayload = z.output<typeof smsPayload>;

const sendSmsBatch: StepTypeDef<SmsPayload> = {
  type: 'send_sms_batch',
  approvalClass: 'message',
  payload: smsPayload,
  /**
   * A marketing text must name the company and say how to opt out (spec 4.5: refused at draft time,
   * and the send gate checks it again). The name counts as `{company}` (which becomes the name when
   * the text is rendered) or as the company's own name, in any case.
   */
  validate(p, facts) {
    if (p.purpose !== 'marketing') return null;
    const body = p.body.toLowerCase();
    const name = facts.companyName.trim().toLowerCase();
    const namesCompany = p.body.includes('{company}') || (name !== '' && body.includes(name));
    return namesCompany && body.includes('reply stop to opt out') ? null : MARKETING_TEXT_MESSAGE;
  },
  preview(p, facts) {
    const recipientCount = facts.recipientCount ?? p.customerIds.length;
    return {
      title: `Text ${plural(recipientCount, 'customer', 'customers')}`,
      lines: [
        p.purpose === 'marketing' ? 'Marketing message' : 'Informational message',
        "Customers who can't be texted are skipped.",
      ],
      messageSample: renderBody(p.body, {
        ...(facts.sampleFirstName !== undefined && { first_name: facts.sampleFirstName }),
        company: facts.companyName,
      }),
      recipientCount,
    };
  },
  minutesSaved(_p, result) {
    const sent = result.sent;
    return typeof sent === 'number' && Number.isFinite(sent) && sent > 0 ? Math.min(120, 1.5 * sent) : 0;
  },
};

// ---------------------------------------------------------------------------------------------
// send_email_batch (marketing only: informational email is not a Storm Scout step)

const SUBJECT_MESSAGE = 'Please write the subject.';
const EMAIL_WRITE_MESSAGE = 'Please write the message.';
const EMAIL_PICK_CUSTOMERS = 'Please pick customers from your list.';
const STORM_MESSAGE = 'Please check this storm.';

const sendEmailPayload = z.strictObject({
  purpose: z.literal('marketing', { error: 'Emails to customers are marketing emails.' }),
  subject: z
    .string({ error: SUBJECT_MESSAGE })
    .trim()
    .min(1, SUBJECT_MESSAGE)
    .max(200, 'Please keep the subject to 200 characters or fewer.')
    .refine(noNul, CHECK_TEXT),
  body: z
    .string({ error: EMAIL_WRITE_MESSAGE })
    .trim()
    .min(1, EMAIL_WRITE_MESSAGE)
    .max(10000, 'Please keep the message to 10,000 characters or fewer.')
    .refine(noNul, CHECK_TEXT),
  customerIds: z
    .array(
      z.uuid({ error: EMAIL_PICK_CUSTOMERS }).transform((id) => id.toLowerCase()),
      { error: EMAIL_PICK_CUSTOMERS },
    )
    .min(1, 'Please pick at least one customer.')
    .max(5000, 'You can email at most 5,000 customers in one go.')
    .refine((ids) => new Set(ids).size === ids.length, 'Each customer can only be listed once.'),
  /** Email keys are lower-case customer ids, the same form as customerIds (the SMS map is not checked for case). */
  fields: fieldsMap
    .refine((fields) => Object.keys(fields).every((id) => id === id.toLowerCase()), FIELDS_MESSAGE)
    .optional(),
  dedupePrefix: z
    .string({ error: CHECK_TEXT })
    .trim()
    .min(1, CHECK_TEXT)
    .max(100, 'Please keep that to 100 characters or fewer.')
    .refine(noNul, CHECK_TEXT)
    .optional(),
  companyStormId: z.uuid({ error: STORM_MESSAGE }).optional(),
});
type SendEmailPayload = z.output<typeof sendEmailPayload>;

const sendEmailBatch: StepTypeDef<SendEmailPayload> = {
  type: 'send_email_batch',
  approvalClass: 'message',
  payload: sendEmailPayload,
  preview(p, facts) {
    const recipientCount = facts.recipientCount ?? p.customerIds.length;
    return {
      title: `Email ${plural(recipientCount, 'customer', 'customers')}`,
      lines: ['Marketing email', "Customers who can't be emailed are skipped."],
      messageSample: renderStormTemplate(p.body, {
        first_name: facts.sampleFirstName ?? 'Sam',
        company: facts.companyName,
        hail_size: '1.75"',
        street: 'Maple St',
        day: 'yesterday',
        ...(facts.companyAddress !== undefined ? { company_address: facts.companyAddress } : {}),
        unsubscribe: '(unsubscribe link)',
      }),
      recipientCount,
    };
  },
  minutesSaved(_p, result) {
    return Math.min(120, 0.5 * resultCount(result.sent));
  },
  userCreatable: true,
  baseline: () => 'email_sent',
  units: (_p, result) => resultCount(result.sent),
};

// ---------------------------------------------------------------------------------------------
// build_routes (internal: the crew plans the knocks; nothing goes out to a customer)

const DOORS_MESSAGE = 'Please enter the most doors, as a whole number.';
const REP_MESSAGE = 'Please pick reps from your team.';

const buildRoutesPayload = z.strictObject({
  companyStormId: z.uuid({ error: STORM_MESSAGE }),
  repUserIds: z
    .array(
      z.uuid({ error: REP_MESSAGE }).transform((id) => id.toLowerCase()),
      { error: REP_MESSAGE },
    )
    .min(1, 'Please pick at least one rep.')
    .refine((ids) => new Set(ids).size === ids.length, 'Each rep can only be listed once.'),
  maxDoors: z
    .number({ error: DOORS_MESSAGE })
    .int(DOORS_MESSAGE)
    .min(1, DOORS_MESSAGE)
    .max(MAX_DOORS_PER_PLAN, 'You can plan at most 1,500 doors.'),
});
type BuildRoutesPayload = z.output<typeof buildRoutesPayload>;

/** How many routes a plan makes: at least one per rep, and no route over MAX_DOORS_PER_ROUTE doors (as splitIntoRoutes does). */
function routeCount(reps: number, maxDoors: number): number {
  return Math.max(reps, Math.ceil(maxDoors / MAX_DOORS_PER_ROUTE));
}

const buildRoutes: StepTypeDef<BuildRoutesPayload> = {
  type: 'build_routes',
  approvalClass: 'internal',
  payload: buildRoutesPayload,
  preview(p) {
    const reps = p.repUserIds.length;
    const doors = p.maxDoors;
    const routes = routeCount(reps, doors);
    const perRoute = Math.ceil(doors / routes);
    // Routes go to reps in turn (as splitIntoRoutes deals them), so the first `routes % reps` reps get one more.
    let remaining = doors;
    const lines = p.repUserIds.map((_id, i) => {
      const repRoutes = Math.floor(routes / reps) + (i < routes % reps ? 1 : 0);
      const repDoors = Math.min(repRoutes * perRoute, remaining);
      remaining -= repDoors;
      return `Rep ${i + 1}: ${plural(repRoutes, 'route', 'routes')}, up to ${plural(repDoors, 'door', 'doors')}`;
    });
    return {
      title: `${plural(routes, 'door-knock route', 'door-knock routes')} · ${plural(doors, 'door', 'doors')}`,
      lines,
    };
  },
  minutesSaved(_p, result) {
    return 45 * resultCount(result.routes);
  },
  userCreatable: true,
  baseline: () => 'route_built',
  units: (_p, result) => resultCount(result.routes),
};

// ---------------------------------------------------------------------------------------------
// create_ad_campaign (spend: the money is only spent once a person has approved the campaign)

const AD_SPEND_MESSAGE = 'Please enter the most to spend, from $5 to $10,000.';
const AD_DAYS_MESSAGE = 'Please pick 1 to 30 days.';
const AD_PLATFORM_MESSAGE = 'Please pick Google or Facebook and Instagram.';
const GOOGLE_KEYWORDS_MESSAGE = 'Google ads need at least one keyword.';
const META_TEXT_MESSAGE = 'Facebook and Instagram ads need the main text.';

const adKeyword = z
  .string({ error: 'Please check the keywords.' })
  .trim()
  .min(1, 'Please check the keywords.')
  .max(80, 'Please keep each keyword to 80 characters or fewer.')
  .refine(noNul, CHECK_TEXT);

const createAdPayload = z
  .strictObject({
    companyStormId: z.uuid({ error: STORM_MESSAGE }),
    platform: z.enum(AD_PLATFORMS, { error: AD_PLATFORM_MESSAGE }),
    maxSpendCents: z
      .number({ error: AD_SPEND_MESSAGE })
      .int(AD_SPEND_MESSAGE)
      .min(500, AD_SPEND_MESSAGE)
      .max(1_000_000, AD_SPEND_MESSAGE),
    days: z.number({ error: AD_DAYS_MESSAGE }).int(AD_DAYS_MESSAGE).min(1, AD_DAYS_MESSAGE).max(30, AD_DAYS_MESSAGE),
    headline: z
      .string({ error: 'Please write the headline.' })
      .trim()
      .min(1, 'Please write the headline.')
      .max(120, 'Please keep the headline to 120 characters or fewer.')
      .refine(noNul, CHECK_TEXT),
    description: z
      .string({ error: 'Please write the description.' })
      .trim()
      .min(1, 'Please write the description.')
      .max(300, 'Please keep the description to 300 characters or fewer.')
      .refine(noNul, CHECK_TEXT),
    keywords: z
      .array(adKeyword, { error: 'Please check the keywords.' })
      .max(20, 'You can use at most 20 keywords.')
      .optional(),
    primaryText: z
      .string({ error: 'Please check the main text.' })
      .trim()
      .min(1, 'Please write the main text.')
      .max(500, 'Please keep the main text to 500 characters or fewer.')
      .refine(noNul, CHECK_TEXT)
      .optional(),
    photoId: z.uuid({ error: 'Please check this photo.' }).nullable().optional(),
  })
  .superRefine((p, ctx) => {
    const problem = adNeedsProblem(p);
    if (problem === null) return;
    ctx.addIssue({
      code: 'custom',
      path: [problem.field],
      message: problem.message,
    });
  });
type CreateAdPayload = z.output<typeof createAdPayload>;

/** The platform's own minimum: Google needs keywords, Facebook and Instagram need the main text. */
function adNeedsProblem(p: {
  platform: 'google' | 'meta';
  keywords?: string[] | undefined;
  primaryText?: string | undefined;
}): { field: 'keywords' | 'primaryText'; message: string } | null {
  if (p.platform === 'google' && (p.keywords === undefined || p.keywords.length === 0)) {
    return { field: 'keywords', message: GOOGLE_KEYWORDS_MESSAGE };
  }
  if (p.platform === 'meta' && p.primaryText === undefined) {
    return { field: 'primaryText', message: META_TEXT_MESSAGE };
  }
  return null;
}

const createAdCampaign: StepTypeDef<CreateAdPayload> = {
  type: 'create_ad_campaign',
  approvalClass: 'spend',
  payload: createAdPayload,
  validate(p) {
    return adNeedsProblem(p)?.message ?? null;
  },
  preview(p) {
    const perDayCents = dailyBudgetCents(p.maxSpendCents, p.days);
    return {
      title: p.platform === 'google' ? 'Google ads on the hail area' : 'Facebook and Instagram ads on the hail area',
      lines: ['Circles cover the hail area', `${dollars.format(perDayCents / 100)} a day for ${p.days} days`],
      maxSpendCents: p.maxSpendCents,
    };
  },
  minutesSaved: (_p, result) => 45 * resultCount(result.campaigns),
  userCreatable: true,
  baseline: () => 'ad_campaign',
  units: (_p, result) => resultCount(result.campaigns),
};

// ---------------------------------------------------------------------------------------------
// send_proposal

/** A proposal text must keep the link, so the homeowner can open the proposal from it. */
export const PROPOSAL_LINK_MESSAGE = 'Keep {link} in the message so they can open the proposal.';
const PROPOSAL_LINK_TOKEN = '{link}';
const SAMPLE_PROPOSAL_LINK = 'https://example.com/p/abc123';
const TIER_LABELS: Record<Tier, string> = { good: 'Good', better: 'Better', best: 'Best' };
const BASIS_LINES: Record<MeasurementKind, string> = {
  estimate: 'Estimate based on the roof outline.',
  exact: 'Based on an exact roof report.',
};

const PICK_CUSTOMER = 'Please pick a customer from your list.';
const PRICES_MESSAGE = 'Please check the prices.';

const proposalPayload = z.strictObject({
  proposalId: z
    .uuid({ error: 'Please pick a proposal.' })
    .transform((id) => id.toLowerCase()),
  customerId: z
    .uuid({ error: PICK_CUSTOMER })
    .transform((id) => id.toLowerCase()),
  body: z
    .string({ error: WRITE_MESSAGE })
    .trim()
    .min(1, WRITE_MESSAGE)
    .max(640, 'Please keep the message to 640 characters or fewer.')
    .refine(noNul, CHECK_TEXT),
  basis: z.enum(MEASUREMENT_KINDS, { error: 'Please pick estimate or exact.' }),
  /** One entry per enabled option, in TIERS order: the tier names the total in the preview. */
  totals: z
    .array(
      z.strictObject(
        {
          tier: z.enum(TIERS, { error: PRICES_MESSAGE }),
          totalCents: z.number({ error: PRICES_MESSAGE }).int(PRICES_MESSAGE).min(0, PRICES_MESSAGE),
        },
        { error: PRICES_MESSAGE },
      ),
      { error: PRICES_MESSAGE },
    )
    .min(1, PRICES_MESSAGE)
    .max(3, PRICES_MESSAGE),
});
type ProposalPayload = z.output<typeof proposalPayload>;

/** "Good $11,900 · Better $14,250 · Best $17,600": each enabled option's total, labelled by its tier. */
function tierTotalsLine(totals: ProposalPayload['totals']): string {
  return totals.map((t) => `${TIER_LABELS[t.tier]} ${wholeDollars.format(t.totalCents / 100)}`).join(' · ');
}

const sendProposal: StepTypeDef<ProposalPayload> = {
  type: 'send_proposal',
  approvalClass: 'message',
  payload: proposalPayload,
  validate: (p) => (p.body.includes(PROPOSAL_LINK_TOKEN) ? null : PROPOSAL_LINK_MESSAGE),
  preview(p, facts) {
    return {
      title: `Text the proposal to ${facts.sampleFirstName ?? 'the customer'}`,
      lines: [tierTotalsLine(p.totals), BASIS_LINES[p.basis]],
      messageSample: renderBody(p.body.replaceAll(PROPOSAL_LINK_TOKEN, SAMPLE_PROPOSAL_LINK), {
        ...(facts.sampleFirstName !== undefined && { first_name: facts.sampleFirstName }),
        company: facts.companyName,
      }),
      recipientCount: 1,
    };
  },
  minutesSaved: () => 20,
};

// ---------------------------------------------------------------------------------------------
// order_exact_report

const ADDRESS_MESSAGE = 'Please enter the address.';

const exactReportPayload = z.strictObject({
  orderId: z
    .uuid({ error: 'Please pick an order.' })
    .transform((id) => id.toLowerCase()),
  measurementId: z
    .uuid({ error: 'Please pick a measurement.' })
    .transform((id) => id.toLowerCase()),
  address: z
    .string({ error: ADDRESS_MESSAGE })
    .trim()
    .min(1, ADDRESS_MESSAGE)
    .max(300, 'Please keep the address to 300 characters or fewer.')
    .refine(noNul, CHECK_TEXT),
  maxSpendCents,
});
type ExactReportPayload = z.output<typeof exactReportPayload>;

const orderExactReport: StepTypeDef<ExactReportPayload> = {
  type: 'order_exact_report',
  approvalClass: 'spend',
  payload: exactReportPayload,
  preview: (p) => ({ title: 'Order an exact roof report', lines: [p.address], maxSpendCents: p.maxSpendCents }),
  minutesSaved: () => 10,
};

// ---------------------------------------------------------------------------------------------

// Each definition is checked against its own payload type above; the registry is indexed by a
// step's type at run time, so it holds them as the wider type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const stepTypes: Record<StepType, StepTypeDef<any>> = {
  demo_noop: demoNoop,
  demo_message: demoMessage,
  demo_spend: demoSpend,
  send_sms_batch: sendSmsBatch,
  send_email_batch: sendEmailBatch,
  build_routes: buildRoutes,
  create_ad_campaign: createAdCampaign,
  send_proposal: sendProposal,
  order_exact_report: orderExactReport,
};

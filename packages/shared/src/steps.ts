import { z } from 'zod';
import type { ApprovalClass } from './enums.ts';
import { MESSAGE_PURPOSES } from './enums.ts';
import { renderBody } from './render.ts';
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
  'send_proposal',
  'order_exact_report',
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export function isStepType(value: unknown): value is StepType {
  return typeof value === 'string' && (STEP_TYPES as readonly string[]).includes(value);
}

/** What a preview can be built from besides the payload itself. The API looks these up; the registry never does. */
export type PreviewFacts = { companyName: string; recipientCount?: number; sampleFirstName?: string };

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
  send_proposal: sendProposal,
  order_exact_report: orderExactReport,
};

import { z } from 'zod';
import type { ApprovalClass } from './enums.ts';
import { MESSAGE_PURPOSES } from './enums.ts';
import { type BaselineKey, minutesFor } from './agents.ts';
import { renderBody } from './render.ts';
import { MEASUREMENT_KINDS, type MeasurementKind } from './proposals.ts';

/*
 * The step-type registry (spec 4.1): what each kind of step an agent can put in a task needs, in
 * one place. For a step type it says
 * - which approval a person needs to give for it (`approvalClass`: the agent never chooses),
 * - what its payload must look like (`payload`, a zod schema with plain-English messages) and any
 *   rule that needs more than the shape (`validate`, today only the marketing-text rule),
 * - what the review screen shows (`preview`),
 * - whether a person may create it by hand (`userCreatable`; the front desk types are written by
 *   the agent only), and
 * - how many minutes of staff time it saved once it ran: a time-saved `baseline` key (from
 *   TIME_BASELINES in agents.ts), a count of `units` from the step's result, optional call length
 *   (`extraMinutes`) and optional `bookings`. `stepMinutes` turns those into minutes.
 * `minutesSaved` is kept as a compatibility function that uses the default minutes. Task 3 moves
 * the task service onto per-task snapshots and removes it.
 * The API builds previews and checks payloads from here, and the runner adds up the minutes.
 */

export const STEP_TYPES = [
  'demo_noop',
  'demo_message',
  'demo_spend',
  'send_sms_batch',
  'send_proposal',
  'order_exact_report',
  'front_desk_call',
  'front_desk_texts',
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export function isStepType(value: unknown): value is StepType {
  return typeof value === 'string' && (STEP_TYPES as readonly string[]).includes(value);
}

/** True for a step type a person may create by hand (the API checks this in createTask). */
export function isUserCreatableStepType(value: unknown): value is StepType {
  return isStepType(value) && stepTypes[value].userCreatable;
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
  /** False for the step types only the agent writes (the front desk ones): a person cannot create them. */
  userCreatable: boolean;
  payload: z.ZodType<P>;
  /** A rule the shape cannot say. Returns the sentence to show a person, or null when the payload is fine. */
  validate?(p: P, facts: { companyName: string }): string | null;
  preview(p: P, facts: PreviewFacts): StepPreview;
  /** The time-saved baseline (TIME_BASELINES key) this step counts against. */
  baseline(p: P, result: StepResult): BaselineKey;
  /** How many units of that baseline the finished step did (0 when none). */
  units(p: P, result: StepResult): number;
  /** The call's own length in minutes, for the baselines with `perCallLength`. */
  extraMinutes?(p: P, result: StepResult): { callMinutes?: number };
  /** Booking units the step also did; each counts at the `booking` baseline. */
  bookings?(p: P, result: StepResult): number;
  /** Compatibility (Ruling AX-A): minutes saved at the default minutes. Task 3 removes it. */
  minutesSaved(p: P, result: StepResult): number;
}

export type StepMinutes = { baseline: BaselineKey; units: number; minutesPerUnit: number; minutes: number };

/**
 * The minutes one finished step saved, with `overrides` the owner's per-key minutes (hidden keys
 * ignore them). Front desk steps count booking units too: minutes = call/reply minutes + bookings
 * x the booking baseline. Caps apply inside `minutesFor` (send_sms_batch: text_sent at 120).
 */
export function stepMinutes<P>(
  def: StepTypeDef<P>,
  p: P,
  result: StepResult,
  overrides: Partial<Record<BaselineKey, number>> = {},
): StepMinutes {
  const baseline = def.baseline(p, result);
  const units = def.units(p, result);
  const main = minutesFor(baseline, units, overrides, def.extraMinutes?.(p, result));
  const bookings = def.bookings?.(p, result) ?? 0;
  const bookingMinutes = bookings > 0 ? minutesFor('booking', bookings, overrides).minutes : 0;
  const minutes = main.minutes + bookingMinutes;
  const minutesPerUnit = units > 0 ? minutes / units : main.minutesPerUnit;
  return { baseline, units, minutesPerUnit, minutes };
}

/** A step type without its compatibility `minutesSaved`, which is derived from the definition below. */
type StepTypeBase<P> = Omit<StepTypeDef<P>, 'minutesSaved'>;

/** Adds the compatibility `minutesSaved` (default minutes, caps applied) to a definition. */
function withMinutesSaved<P>(def: StepTypeBase<P>): StepTypeDef<P> {
  const full: StepTypeDef<P> = { ...def, minutesSaved: (p, result) => stepMinutes(full, p, result).minutes };
  return full;
}

/** A count from a step's result: a finite number above zero, else 0. Anything else never counts. */
function countOf(value: StepResult[string] | undefined): number {
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

/** The demo steps count one `demo` unit (5 minutes, hidden) once they are done; the caller ensures that. */
const demoNoop = withMinutesSaved<LabelPayload>({
  type: 'demo_noop',
  approvalClass: 'internal',
  userCreatable: true,
  payload: labelPayload,
  preview: (p) => ({ title: p.label, lines: [] }),
  baseline: () => 'demo',
  units: () => 1,
});

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

const demoMessage = withMinutesSaved<MessagePayload>({
  type: 'demo_message',
  approvalClass: 'message',
  userCreatable: true,
  payload: messagePayload,
  preview: (p) => ({
    title: p.label,
    lines: [],
    ...(p.sample !== undefined && { messageSample: p.sample }),
    ...(p.recipientCount !== undefined && { recipientCount: p.recipientCount }),
    ...(p.sendTime !== undefined && { sendTime: p.sendTime }),
  }),
  baseline: () => 'demo',
  units: () => 1,
});

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

const demoSpend = withMinutesSaved<SpendPayload>({
  type: 'demo_spend',
  approvalClass: 'spend',
  userCreatable: true,
  payload: spendPayload,
  preview: (p) => ({
    title: p.label,
    lines: [`Spends up to ${dollars.format(p.maxSpendCents / 100)}`, ...(p.area !== undefined ? [p.area] : [])],
    maxSpendCents: p.maxSpendCents,
  }),
  baseline: () => 'demo',
  units: () => 1,
});

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

const sendSmsBatch = withMinutesSaved<SmsPayload>({
  type: 'send_sms_batch',
  approvalClass: 'message',
  userCreatable: true,
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
  /** Only the `sent` count is a unit (blocked or other counts never are); text_sent caps at 120 minutes. */
  baseline: () => 'text_sent',
  units: (_p, result) => countOf(result.sent),
});

// ---------------------------------------------------------------------------------------------
// Front desk steps (Ruling AX-E: the time they save is measured from what the agent handled).
// They are written by the agent, never by a person: `userCreatable` is false and the approval is
// internal. Bookings made during a call or a text count too, at the `booking` baseline.

/** A front desk step's label is for the review screen only; the real payload is internal. */
const frontDeskPayload = z.strictObject({ label });
type FrontDeskPayload = z.output<typeof frontDeskPayload>;

/** A spam call is counted at the length of the line only (baseline spam_call), with no bookings. */
const isSpam = (result: StepResult): boolean => countOf(result.spam) > 0;

const frontDeskCall = withMinutesSaved<FrontDeskPayload>({
  type: 'front_desk_call',
  approvalClass: 'internal',
  userCreatable: false,
  payload: frontDeskPayload,
  preview: (p) => ({ title: p.label, lines: [] }),
  baseline: (_p, result) => (isSpam(result) ? 'spam_call' : 'call_answered'),
  units: () => 1,
  extraMinutes: (_p, result) => ({ callMinutes: countOf(result.seconds) / 60 }),
  bookings: (_p, result) => (isSpam(result) ? 0 : countOf(result.bookings)),
});

const frontDeskTexts = withMinutesSaved<FrontDeskPayload>({
  type: 'front_desk_texts',
  approvalClass: 'internal',
  userCreatable: false,
  payload: frontDeskPayload,
  preview: (p) => ({ title: p.label, lines: [] }),
  baseline: () => 'text_reply',
  units: (_p, result) => countOf(result.replies),
  bookings: (_p, result) => countOf(result.bookings),
});

// ---------------------------------------------------------------------------------------------
// send_proposal

/** A proposal text must keep the link, so the homeowner can open the proposal from it. */
export const PROPOSAL_LINK_MESSAGE = 'Keep {link} in the message so they can open the proposal.';
const PROPOSAL_LINK_TOKEN = '{link}';
const SAMPLE_PROPOSAL_LINK = 'https://example.com/p/abc123';
const TIER_LABELS = ['Good', 'Better', 'Best'] as const;
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
  totals: z
    .array(z.number({ error: PRICES_MESSAGE }).int(PRICES_MESSAGE).min(0, PRICES_MESSAGE), { error: PRICES_MESSAGE })
    .min(1, PRICES_MESSAGE)
    .max(3, PRICES_MESSAGE),
});
type ProposalPayload = z.output<typeof proposalPayload>;

/** "Good $11,900 · Better $14,250 · Best $17,600" for three options; plain amounts for any other count. */
function tierTotalsLine(totals: number[]): string {
  return totals
    .map((total, i) => {
      const amount = wholeDollars.format(total / 100);
      const label = totals.length === 3 ? TIER_LABELS[i] : undefined;
      return label === undefined ? amount : `${label} ${amount}`;
    })
    .join(' · ');
}

const sendProposal = withMinutesSaved<ProposalPayload>({
  type: 'send_proposal',
  approvalClass: 'message',
  userCreatable: true,
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
  baseline: () => 'proposal_sent',
  units: () => 1,
});

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

const orderExactReport = withMinutesSaved<ExactReportPayload>({
  type: 'order_exact_report',
  approvalClass: 'spend',
  userCreatable: true,
  payload: exactReportPayload,
  preview: (p) => ({ title: 'Order an exact roof report', lines: [p.address], maxSpendCents: p.maxSpendCents }),
  baseline: () => 'exact_report',
  units: () => 1,
});

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
  front_desk_call: frontDeskCall,
  front_desk_texts: frontDeskTexts,
};

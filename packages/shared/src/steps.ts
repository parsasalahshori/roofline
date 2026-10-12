import { z } from 'zod';
import type { ApprovalClass } from './enums.ts';
import { MESSAGE_PURPOSES } from './enums.ts';
import { type BaselineKey, minutesFor } from './agents.ts';
import { renderBody } from './render.ts';
import { claimsGuard } from './claims-guard.ts';
import { FOLLOW_UP_KINDS } from './more-agents.ts';

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
 * The API builds previews and checks payloads from here, and the runner adds up the minutes.
 */

export const STEP_TYPES = [
  'demo_noop',
  'demo_message',
  'demo_spend',
  'send_sms_batch',
  'front_desk_call',
  'front_desk_texts',
  'send_personal_texts',
  'build_claim_packet',
  'create_appointment',
  'move_appointment',
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
const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------
// Demo steps (the 3-step demo task of F2, and the tests)

const labelPayload = z.strictObject({ label });
type LabelPayload = z.output<typeof labelPayload>;

/** The demo steps count one `demo` unit (5 minutes, hidden) once they are done; the caller ensures that. */
const demoNoop: StepTypeDef<LabelPayload> = {
  type: 'demo_noop',
  approvalClass: 'internal',
  userCreatable: true,
  payload: labelPayload,
  preview: (p) => ({ title: p.label, lines: [] }),
  baseline: () => 'demo',
  units: () => 1,
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
  userCreatable: true,
  payload: spendPayload,
  preview: (p) => ({
    title: p.label,
    lines: [`Spends up to ${dollars.format(p.maxSpendCents / 100)}`, ...(p.area !== undefined ? [p.area] : [])],
    maxSpendCents: p.maxSpendCents,
  }),
  baseline: () => 'demo',
  units: () => 1,
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
};

// ---------------------------------------------------------------------------------------------
// Front desk steps (Ruling AX-E: the time they save is measured from what the agent handled).
// They are written by the agent, never by a person: `userCreatable` is false and the approval is
// internal. Bookings made during a call or a text count too, at the `booking` baseline.

/** A front desk step's label is for the review screen only; the real payload is internal. */
const frontDeskPayload = z.strictObject({ label });
type FrontDeskPayload = z.output<typeof frontDeskPayload>;

/** A spam call is counted at the length of the line only (baseline spam_call), with no bookings. */
const isSpam = (result: StepResult): boolean => countOf(result.spam) > 0;

const frontDeskCall: StepTypeDef<FrontDeskPayload> = {
  type: 'front_desk_call',
  approvalClass: 'internal',
  userCreatable: false,
  payload: frontDeskPayload,
  preview: (p) => ({ title: p.label, lines: [] }),
  baseline: (_p, result) => (isSpam(result) ? 'spam_call' : 'call_answered'),
  units: () => 1,
  extraMinutes: (_p, result) => ({ callMinutes: countOf(result.seconds) / 60 }),
  bookings: (_p, result) => (isSpam(result) ? 0 : countOf(result.bookings)),
};

const frontDeskTexts: StepTypeDef<FrontDeskPayload> = {
  type: 'front_desk_texts',
  approvalClass: 'internal',
  userCreatable: false,
  payload: frontDeskPayload,
  preview: (p) => ({ title: p.label, lines: [] }),
  baseline: () => 'text_reply',
  units: (_p, result) => countOf(result.replies),
  bookings: (_p, result) => countOf(result.bookings),
};

// ---------------------------------------------------------------------------------------------
// G1 steps (Task 2b): personal follow-up texts, the claim packet and the two calendar steps.
// All four are written by the agent only; the texts need a person's approval, the rest are internal.

const lowerUuid = (message?: string) =>
  z.uuid(message === undefined ? undefined : { error: message }).transform((id) => id.toLowerCase());

export const CLAIMS_TEXT_MESSAGE = 'This text talks about prices, insurance coverage or deductibles, or offers to deal with the insurer. Please change it.';
export const REVIEW_PURPOSE_MESSAGE = 'Review requests go out as marketing texts.';

const personalMessage = z.strictObject({
  customerId: lowerUuid(PICK_CUSTOMERS),
  jobId: lowerUuid(CHECK_TEXT).nullable(),
  body: z
    .string({ error: WRITE_MESSAGE })
    .min(1, WRITE_MESSAGE)
    .max(480, 'Please keep the message to 480 characters or fewer.')
    .refine(noNul, CHECK_TEXT),
});

const personalTextsPayload = z.strictObject({
  purpose: z.enum(MESSAGE_PURPOSES, { error: 'Please pick marketing or informational.' }),
  kind: z.enum(FOLLOW_UP_KINDS, { error: CHECK_TEXT }),
  messages: z
    .array(personalMessage, { error: CHECK_TEXT })
    .min(1, 'Please pick at least one customer.')
    .max(100, 'You can text at most 100 customers in one go.')
    .refine((items) => new Set(items.map((m) => m.customerId)).size === items.length, 'Each customer can only be listed once.'),
  dedupePrefix: z
    .string({ error: CHECK_TEXT })
    .min(1, CHECK_TEXT)
    .max(80, CHECK_TEXT)
    .regex(/^[a-z0-9:_-]+$/, CHECK_TEXT),
});
type PersonalTextsPayload = z.output<typeof personalTextsPayload>;

const sendPersonalTexts: StepTypeDef<PersonalTextsPayload> = {
  type: 'send_personal_texts',
  approvalClass: 'message',
  userCreatable: false,
  payload: personalTextsPayload,
  validate(p) {
    if (p.messages.some((m) => !claimsGuard(m.body).ok)) return CLAIMS_TEXT_MESSAGE;
    if (p.kind === 'review' && p.purpose !== 'marketing') return REVIEW_PURPOSE_MESSAGE;
    return null;
  },
  preview(p) {
    const n = p.messages.length;
    const lines = p.messages.slice(0, 20).map((m) => m.body);
    if (n > 20) lines.push(`and ${n - 20} more`);
    return {
      title: `Send ${n} personal text${n === 1 ? '' : 's'}`,
      lines,
      ...(p.messages[0] !== undefined && { messageSample: p.messages[0].body }),
      recipientCount: n,
    };
  },
  baseline: (p) => (p.kind === 'reminder' ? 'reminder_sent' : 'follow_up_sent'),
  units: (_p, result) => countOf(result.sent),
};

const claimPacketPayload = z.strictObject({ jobId: lowerUuid(CHECK_TEXT) });
type ClaimPacketPayload = z.output<typeof claimPacketPayload>;

const buildClaimPacket: StepTypeDef<ClaimPacketPayload> = {
  type: 'build_claim_packet',
  approvalClass: 'internal',
  userCreatable: false,
  payload: claimPacketPayload,
  preview: () => ({ title: 'Build the claim packet', lines: [] }),
  baseline: () => 'claim_packet',
  units: (_p, result) => (countOf(result.built) > 0 ? 1 : 0),
};

const END_AFTER_START = 'The end must be after the start.';
const isoTime = z.iso.datetime({ offset: true, error: CHECK_TEXT });
const endsAfterStart = (v: { start: string; end: string }): boolean => Date.parse(v.end) > Date.parse(v.start);

const createAppointmentPayload = z
  .strictObject({
    jobId: lowerUuid(CHECK_TEXT),
    kind: z.enum(['adjuster', 'inspection'], { error: CHECK_TEXT }),
    start: isoTime,
    end: isoTime,
    userId: lowerUuid(CHECK_TEXT),
    note: z.string({ error: CHECK_TEXT }).max(500, 'Please keep the note to 500 characters or fewer.').refine(noNul, CHECK_TEXT),
  })
  .refine(endsAfterStart, { message: END_AFTER_START, path: ['end'] });
type CreateAppointmentPayload = z.output<typeof createAppointmentPayload>;

const createAppointment: StepTypeDef<CreateAppointmentPayload> = {
  type: 'create_appointment',
  approvalClass: 'internal',
  userCreatable: false,
  payload: createAppointmentPayload,
  preview: (p) => ({
    title: p.kind === 'adjuster' ? 'Book an adjuster visit' : 'Book an inspection',
    lines: [`${p.start} to ${p.end}`],
  }),
  baseline: () => 'booking',
  units: (_p, result) => countOf(result.created),
};

const moveAppointmentPayload = z
  .strictObject({
    appointmentId: lowerUuid(CHECK_TEXT),
    start: isoTime,
    end: isoTime,
    userId: lowerUuid(CHECK_TEXT),
    reason: z.string({ error: CHECK_TEXT }).max(200, 'Please keep the reason to 200 characters or fewer.').refine(noNul, CHECK_TEXT),
  })
  .refine(endsAfterStart, { message: END_AFTER_START, path: ['end'] });
type MoveAppointmentPayload = z.output<typeof moveAppointmentPayload>;

const moveAppointment: StepTypeDef<MoveAppointmentPayload> = {
  type: 'move_appointment',
  approvalClass: 'internal',
  userCreatable: false,
  payload: moveAppointmentPayload,
  preview: (p) => ({ title: 'Move an install', lines: [p.reason, `${p.start} to ${p.end}`] }),
  baseline: () => 'install_moved',
  units: (_p, result) => countOf(result.moved),
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
  front_desk_call: frontDeskCall,
  front_desk_texts: frontDeskTexts,
  send_personal_texts: sendPersonalTexts,
  build_claim_packet: buildClaimPacket,
  create_appointment: createAppointment,
  move_appointment: moveAppointment,
};

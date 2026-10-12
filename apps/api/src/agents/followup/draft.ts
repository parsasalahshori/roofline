import {
  type BusyItem,
  claimsGuard,
  DEFAULT_DURATION_MINUTES,
  findSlots,
  localDate,
  type WorkHours,
} from '@roofline/shared';
import { type JobFacts, type Llm, LlmUnavailableError, MAX_DRAFT_JOBS } from '../../providers/llm.ts';

/*
 * Drafting for the Follow-up agent's lead texts (G1 Task 13a): two inspection times for the lead,
 * the Llm's written text, and the template that stands in when the Llm is unavailable or its text
 * fails our checks. Pure: no database. Nothing here logs or prints message text.
 */

export type LeadDraftInput = {
  jobId: string;
  customerId: string;
  customerFirstName: string | null;
  repFirstName: string | null;
  address: string | null;
  slots: [string, string];
};

export type DraftedLeadText = { jobId: string; customerId: string; body: string; fromTemplate: boolean };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SLOT_WINDOW_DAYS = 5;
const SLOT_DATES = 3;
const MIN_NOTICE_MINUTES = 240;
const AFTERNOON_HOUR = 13;
const SAME_DAY_GAP_MS = 3 * HOUR_MS;
/** The longest text we accept from the Llm. */
const MAX_BODY_CHARS = 320;

type LocalParts = { date: string; weekday: string; hour: number; minute: number };

function localParts(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { date: localDate(at, timeZone), weekday: get('weekday'), hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}

/** A start time as plain words in the company zone: 'Thursday 10 AM', 'Friday 2:30 PM'. */
export function formatSlot(start: Date, timeZone: string): string {
  const p = localParts(start, timeZone);
  const suffix = p.hour >= 12 ? 'PM' : 'AM';
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const minutes = p.minute === 0 ? '' : `:${String(p.minute).padStart(2, '0')}`;
  return `${p.weekday} ${hour12}${minutes} ${suffix}`;
}

const WEEKEND = new Set(['Saturday', 'Sunday']);

/** Two inspection start times in the next 3 workdays, on different days where it can, or null. */
export function pickTwoSlots(opts: {
  workHours: WorkHours;
  busy: readonly BusyItem[];
  propertyId: string | null;
  timeZone: string;
  now: Date;
}): [string, string] | null {
  const found = findSlots({
    workHours: opts.workHours,
    busy: opts.busy,
    propertyId: opts.propertyId,
    durationMinutes: DEFAULT_DURATION_MINUTES.inspection,
    bufferMinutes: 0,
    minNoticeMinutes: MIN_NOTICE_MINUTES,
    from: opts.now,
    to: new Date(opts.now.getTime() + SLOT_WINDOW_DAYS * DAY_MS),
    timeZone: opts.timeZone,
    now: opts.now,
  });

  const dates = new Set<string>();
  const slots: { start: Date; parts: LocalParts }[] = [];
  for (const s of found) {
    const parts = localParts(s.start, opts.timeZone);
    if (WEEKEND.has(parts.weekday)) continue;
    if (!dates.has(parts.date)) {
      if (dates.size >= SLOT_DATES) continue;
      dates.add(parts.date);
    }
    slots.push({ start: s.start, parts });
  }

  const first = slots[0];
  if (!first) return null;
  const otherDay = slots.filter((s) => s.parts.date !== first.parts.date);
  const second =
    otherDay.find((s) => s.parts.hour >= AFTERNOON_HOUR) ??
    otherDay[0] ??
    slots.find((s) => s.parts.date === first.parts.date && s.start.getTime() - first.start.getTime() >= SAME_DAY_GAP_MS);
  if (!second) return null;
  return [formatSlot(first.start, opts.timeZone), formatSlot(second.start, opts.timeZone)];
}

/** The text used when the Llm cannot write one, or its text fails a check. */
export function leadTemplate(i: {
  customerFirstName: string | null;
  repFirstName: string | null;
  companyName: string;
  slots: [string, string];
}): string {
  const first = i.customerFirstName ?? 'there';
  const rep = i.repFirstName ?? 'a member of our team';
  return `Hi ${first}, it's ${rep} at ${i.companyName}. We can come look at your roof ${i.slots[0]} or ${i.slots[1]}. Reply with the one that works.`;
}

function acceptable(body: string, slots: [string, string]): boolean {
  // claimsGuard runs D1's guardSentence on every sentence, plus the claims rules (G1 Task 2b).
  if (body.trim() === '' || body.length > MAX_BODY_CHARS) return false;
  if (!claimsGuard(body).ok) return false;
  const lower = body.toLowerCase();
  return slots.every((s) => lower.includes(s.toLowerCase()));
}

/**
 * Writes one text per lead through the Llm. A text that fails a check, a lead the Llm left out, a
 * refusal, or an unavailable Llm gets the template instead. At most MAX_DRAFT_JOBS leads per call.
 */
export async function draftLeadTexts(
  llm: Llm,
  companyName: string,
  leads: readonly LeadDraftInput[],
): Promise<{ texts: DraftedLeadText[]; anyTemplate: boolean }> {
  if (leads.length > MAX_DRAFT_JOBS) throw new RangeError(`At most ${MAX_DRAFT_JOBS} leads per call.`);
  if (leads.length === 0) return { texts: [], anyTemplate: false };

  const facts: JobFacts[] = leads.map((l) => ({
    jobId: l.jobId,
    customerFirstName: l.customerFirstName ?? '',
    companyName,
    repFirstName: l.repFirstName,
    address: l.address,
    facts: { slot1: l.slots[0], slot2: l.slots[1] },
  }));

  const written = new Map<string, string>();
  try {
    const result = await llm.draftTexts({ instruction: 'lead_follow_up', facts });
    if (!result.refused) for (const t of result.texts) written.set(t.jobId, t.body);
  } catch (e) {
    if (!(e instanceof LlmUnavailableError)) throw e;
  }

  let anyTemplate = false;
  const texts = leads.map((l): DraftedLeadText => {
    const body = written.get(l.jobId);
    if (body !== undefined && acceptable(body, l.slots)) {
      return { jobId: l.jobId, customerId: l.customerId, body, fromTemplate: false };
    }
    anyTemplate = true;
    return {
      jobId: l.jobId,
      customerId: l.customerId,
      body: leadTemplate({ customerFirstName: l.customerFirstName, repFirstName: l.repFirstName, companyName, slots: l.slots }),
      fromTemplate: true,
    };
  });
  return { texts, anyTemplate };
}

/** G1 Task 13b: what the proposal text needs. `lowestTotalCents` is the lowest option total, or null. */
export type ProposalDraftInput = {
  jobId: string;
  customerId: string;
  customerFirstName: string | null;
  repFirstName: string | null;
  proposalNumber: string;
  viewed: boolean;
  lowestTotalCents: number | null;
};

export type DraftedProposalText = { jobId: string; customerId: string; body: string; fromTemplate: boolean };

/** The text used when the Llm cannot write one, or its text fails a check. No link, no price. */
export function proposalTemplate(i: {
  customerFirstName: string | null;
  repFirstName: string | null;
  companyName: string;
}): string {
  const first = i.customerFirstName ?? 'there';
  const rep = i.repFirstName ?? 'a member of our team';
  return `Hi ${first}, it's ${rep} at ${i.companyName}. Just checking you got the roof proposal we sent. Happy to answer any questions \u2014 reply here or call us.`;
}

function acceptableProposalBody(body: string): boolean {
  if (body.trim() === '' || body.length > MAX_BODY_CHARS) return false;
  return claimsGuard(body).ok;
}

/**
 * Writes one text per unsigned proposal through the Llm. A text that fails a check, a proposal the
 * Llm left out, a refusal, or an unavailable Llm gets the template instead. At most MAX_DRAFT_JOBS.
 */
export async function draftProposalTexts(
  llm: Llm,
  companyName: string,
  proposals: readonly ProposalDraftInput[],
): Promise<{ texts: DraftedProposalText[]; anyTemplate: boolean }> {
  if (proposals.length > MAX_DRAFT_JOBS) throw new RangeError(`At most ${MAX_DRAFT_JOBS} proposals per call.`);
  if (proposals.length === 0) return { texts: [], anyTemplate: false };

  const facts: JobFacts[] = proposals.map((p) => ({
    jobId: p.jobId,
    customerFirstName: p.customerFirstName ?? '',
    companyName,
    repFirstName: p.repFirstName,
    address: null,
    facts: {
      proposalNumber: p.proposalNumber,
      viewed: p.viewed ? 'yes' : 'no',
      ...(p.lowestTotalCents !== null && {
        lowestTotal: '$' + (p.lowestTotalCents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 }),
      }),
    },
  }));

  const written = new Map<string, string>();
  try {
    const result = await llm.draftTexts({ instruction: 'proposal_follow_up', facts });
    if (!result.refused) for (const t of result.texts) written.set(t.jobId, t.body);
  } catch (e) {
    if (!(e instanceof LlmUnavailableError)) throw e;
  }

  let anyTemplate = false;
  const texts = proposals.map((p): DraftedProposalText => {
    const body = written.get(p.jobId);
    if (body !== undefined && acceptableProposalBody(body)) {
      return { jobId: p.jobId, customerId: p.customerId, body, fromTemplate: false };
    }
    anyTemplate = true;
    return {
      jobId: p.jobId,
      customerId: p.customerId,
      body: proposalTemplate({ customerFirstName: p.customerFirstName, repFirstName: p.repFirstName, companyName }),
      fromTemplate: true,
    };
  });
  return { texts, anyTemplate };
}

/** G1 Task 14: what the review request needs. */
export type ReviewDraftInput = {
  jobId: string;
  customerId: string;
  customerFirstName: string | null;
  repFirstName: string | null;
  reviewLink: string;
};

export type DraftedReviewText = { jobId: string; customerId: string; body: string; fromTemplate: boolean };

const REVIEW_MAX_TEMPLATE_CHARS = 300;

/** The text used when the Llm cannot write one, or its text fails a check. Always carries the link and the STOP line. */
export function reviewTemplate(i: { customerFirstName: string | null; companyName: string; reviewLink: string }): string {
  const first = i.customerFirstName ?? 'there';
  const build = (ask: string) =>
    `Hi ${first}, it's ${i.companyName}. Thanks for choosing us for your new roof. ${ask}: ${i.reviewLink} Reply STOP to opt out.`;
  const long = build('If you have a minute, a short review helps a lot');
  return long.length <= REVIEW_MAX_TEMPLATE_CHARS ? long : build('A short review helps a lot');
}

function acceptableReviewBody(body: string, link: string): boolean {
  if (body.trim() === '' || body.length > MAX_BODY_CHARS) return false;
  if (!claimsGuard(body).ok) return false;
  if (!body.includes(link)) return false;
  return /Reply STOP to opt out\.?$/.test(body.trim());
}

/**
 * Writes one review request per finished job through the Llm. A text that fails a check, a job the
 * Llm left out, a refusal, or an unavailable Llm gets the template instead. At most MAX_DRAFT_JOBS.
 */
export async function draftReviewTexts(
  llm: Llm,
  companyName: string,
  reviews: readonly ReviewDraftInput[],
): Promise<{ texts: DraftedReviewText[]; anyTemplate: boolean }> {
  if (reviews.length > MAX_DRAFT_JOBS) throw new RangeError(`At most ${MAX_DRAFT_JOBS} reviews per call.`);
  if (reviews.length === 0) return { texts: [], anyTemplate: false };

  const facts: JobFacts[] = reviews.map((r) => ({
    jobId: r.jobId,
    customerFirstName: r.customerFirstName ?? '',
    companyName,
    repFirstName: r.repFirstName,
    address: null,
    facts: { reviewLink: r.reviewLink },
  }));

  const written = new Map<string, string>();
  try {
    const result = await llm.draftTexts({ instruction: 'review_request', facts });
    if (!result.refused) for (const t of result.texts) written.set(t.jobId, t.body);
  } catch (e) {
    if (!(e instanceof LlmUnavailableError)) throw e;
  }

  let anyTemplate = false;
  const texts = reviews.map((r): DraftedReviewText => {
    const body = written.get(r.jobId);
    if (body !== undefined && acceptableReviewBody(body, r.reviewLink)) {
      return { jobId: r.jobId, customerId: r.customerId, body, fromTemplate: false };
    }
    anyTemplate = true;
    return {
      jobId: r.jobId,
      customerId: r.customerId,
      body: reviewTemplate({ customerFirstName: r.customerFirstName, companyName, reviewLink: r.reviewLink }),
      fromTemplate: true,
    };
  });
  return { texts, anyTemplate };
}

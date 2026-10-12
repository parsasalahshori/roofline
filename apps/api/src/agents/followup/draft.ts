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
  // D1: guardSentence (per-sentence check) is not on this base; claimsGuard on the whole text only.
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

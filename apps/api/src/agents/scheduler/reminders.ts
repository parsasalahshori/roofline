import { agentTaskCreatedBetween, reminderCandidates, type ReminderCandidate, schedulerAgentOn, schedulerCompany, type TenantContext, withTenant, zoneDayAfter, zoneDayStart } from '@roofline/db';
import { claimsGuard, guardSentence } from '@roofline/shared';
import type { AppDeps } from '../../app.ts';
import type { JobMeta } from '../../jobs/queue.ts';
import { LlmUnavailableError, MAX_DRAFT_JOBS, type JobFacts } from '../../providers/llm.ts';
import { createTask } from '../../tasks/service.ts';
import { localParts } from '../schedule.ts';

const MAX_BODY = 300;
/** Matches the send_personal_texts payload max in packages/shared/src/steps.ts. */
const MAX_TEXTS_PER_STEP = 100;

function clock(instant: Date, timeZone: string): string {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(instant)) {
    parts[p.type] = p.value;
  }
  return parts.minute === '00' ? `${parts.hour}` : `${parts.hour}:${parts.minute}`;
}

/** The company-local window of a visit: '10' and '11' style, or all day for an install. */
export function reminderWindow(c: ReminderCandidate, timeZone: string): { start: string; end: string; allDay: boolean } {
  return { start: clock(c.startsAt, timeZone), end: clock(c.endsAt, timeZone), allDay: c.kind === 'install' };
}

/** The fixed text used when the model's text is missing or fails a guard. */
export function reminderTemplate(c: ReminderCandidate, companyName: string, timeZone: string): string {
  const rep = c.repFirstName ?? 'our team';
  const address = c.addressLine ?? 'your home';
  const w = reminderWindow(c, timeZone);
  const head = `Hi ${c.customerFirstName}, reminder: ${rep} from ${companyName} will be at ${address} tomorrow`;
  return w.allDay
    ? `${head} for your roof install. Reply C to confirm or call us to change.`
    : `${head} between ${w.start} and ${w.end}. Reply C to confirm or call us to change.`;
}

function bodyOk(body: string): boolean {
  if (body.trim() === '' || body.length > MAX_BODY) return false;
  if (!claimsGuard(body).ok) return false;
  return body.split(/(?<=[.!?])\s+/).every((s) => guardSentence(s, { repName: null }).hits.length === 0);
}

/** The local instant (today) at 9 PM in the zone: the first minute of the day whose local clock reads 21:00. */
function nineLocal(today: string, timeZone: string): Date {
  const start = zoneDayStart(today, timeZone).getTime();
  for (let t = start + 20 * 3_600_000; t <= start + 22 * 3_600_000; t += 60_000) {
    const p = localParts(new Date(t), timeZone);
    if (p.localDate === today && p.hour === 21 && p.minute === 0) return new Date(t);
  }
  return new Date(start + 21 * 3_600_000);
}

/** Tomorrow's reminder texts for one company: one approval task, once per local day. */
export async function runReminders(deps: AppDeps, companyId: string, meta: JobMeta): Promise<void> {
  void meta;
  const ctx: TenantContext = { companyId, userId: null, role: 'system', canApproveSpend: false };
  await withTenant(deps.pools, ctx, async (tx) => {
    const company = await schedulerCompany(tx, ctx);
    if (!company || (company.status !== 'active' && company.status !== 'trial')) return;
    if (!(await schedulerAgentOn(tx, ctx))) return;

    const now = deps.clock.now();
    const tz = company.timezone;
    const today = localParts(now, tz).localDate;
    const tomorrow = zoneDayAfter(today);
    const todayStart = zoneDayStart(today, tz);
    const todayEnd = zoneDayStart(tomorrow, tz);
    if (await agentTaskCreatedBetween(tx, ctx, { agent: 'scheduler', kind: 'reminders', from: todayStart, to: todayEnd })) return;

    const all = await reminderCandidates(tx, ctx, { from: todayEnd, to: zoneDayStart(zoneDayAfter(tomorrow), tz) });
    if (all.length === 0) return;
    const candidates = all;

    const keyOf = (c: ReminderCandidate): string => c.jobId ?? c.appointmentId;
    const facts: JobFacts[] = candidates.map((c) => {
      const w = reminderWindow(c, tz);
      return {
        jobId: keyOf(c),
        customerFirstName: c.customerFirstName,
        companyName: company.name,
        repFirstName: c.repFirstName,
        address: c.addressLine,
        facts: { window: w.allDay ? 'all day' : `between ${w.start} and ${w.end}`, when: 'tomorrow' },
      };
    });
    const drafted = new Map<string, string>();
    for (let i = 0; i < facts.length; i += MAX_DRAFT_JOBS) {
      const chunk = facts.slice(i, i + MAX_DRAFT_JOBS);
      try {
        const res = await deps.llm.draftTexts({ instruction: 'reminder', facts: chunk });
        if (!res.refused) for (const t of res.texts) if (!drafted.has(t.jobId)) drafted.set(t.jobId, t.body);
      } catch (err) {
        if (!(err instanceof LlmUnavailableError)) throw err;
      }
    }

    let usedTemplate = false;
    const messages = candidates.map((c) => {
      const text = drafted.get(keyOf(c));
      if (text !== undefined && bodyOk(text)) return { customerId: c.customerId, jobId: c.jobId, body: text };
      usedTemplate = true;
      return { customerId: c.customerId, jobId: c.jobId, body: reminderTemplate(c, company.name, tz) };
    });

    const steps = [];
    for (let i = 0; i < messages.length; i += MAX_TEXTS_PER_STEP) {
      steps.push({
        type: 'send_personal_texts' as const,
        payload: { purpose: 'informational', kind: 'reminder', messages: messages.slice(i, i + MAX_TEXTS_PER_STEP), dedupePrefix: `reminder:${tomorrow}` },
      });
    }

    await createTask(
      tx,
      ctx,
      {
        agent: 'scheduler',
        kind: 'reminders',
        title: `Reminders for tomorrow (${messages.length} texts)`,
        summary: usedTemplate ? 'Written from a template' : "Drafted for tomorrow's visits.",
        expiresAt: nineLocal(today, tz),
        steps,
      },
      { now, allowInternalStepTypes: true },
    );
  });
}

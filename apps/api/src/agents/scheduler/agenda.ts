import {
  agendaMembers,
  agentCompanyFacts,
  agendaSentBetween,
  customerPhones,
  listAppointments,
  recordAgendaSent,
  g1AgentOn,
  withTenant,
  zoneDayAfter,
  zoneDayStart,
} from '@roofline/db';
import type { AppointmentView } from '@roofline/shared';
import type { AppDeps } from '../../app.ts';
import type { JobMeta } from '../../jobs/queue.ts';
import { systemCtx } from '../common.ts';
import { localParts } from '../schedule.ts';

const KIND_LABEL: Record<string, string> = {
  inspection: 'Inspection',
  install: 'Install',
  adjuster: 'Adjuster visit',
};

export type AgendaVisit = {
  startsAt: string;
  allDay: boolean;
  kind: string;
  customerName: string | null;
  addressLine: string | null;
  phone: string | null;
  notes: string | null;
  jobId: string | null;
};

export type AgendaEmailInput = {
  name: string;
  /** Tomorrow as YYYY-MM-DD in the company zone. */
  day: string;
  timeZone: string;
  appOrigin: string;
  visits: AgendaVisit[];
};

/** "Tuesday, Oct 13" for a YYYY-MM-DD day (parsed at noon UTC so the zone cannot shift it). */
function dayText(day: string, timeZone: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const noon = new Date(Date.UTC(y!, m! - 1, d!, 12));
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone }).formatToParts(noon)) {
    p[part.type] = part.value;
  }
  return `${p.weekday}, ${p.month} ${p.day}`;
}

function timeText(iso: string, timeZone: string): string {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).formatToParts(new Date(iso))) {
    p[part.type] = part.value;
  }
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** The agenda email for one crew member. Pure: no clock, no database. */
export function buildAgendaEmail(input: AgendaEmailInput): { subject: string; text: string } {
  const label = dayText(input.day, input.timeZone);
  const subject = `Your appointments for ${label}`;
  const first = input.name.trim().split(/\s+/)[0] || 'there';
  const blocks = input.visits.map((v) => {
    const lines = [
      `${v.allDay ? 'All day' : timeText(v.startsAt, input.timeZone)} - ${KIND_LABEL[v.kind] ?? 'Appointment'}`,
    ];
    if (v.customerName) lines.push(v.customerName);
    if (v.addressLine) lines.push(v.addressLine);
    if (v.phone) lines.push(v.phone);
    if (v.notes) lines.push(`Notes: ${v.notes}`);
    if (v.jobId !== null) lines.push(`${input.appOrigin}/jobs/${v.jobId}`);
    return lines.join('\n');
  });
  const text = [`Hi ${first}, here is your schedule for ${label}.`, ...blocks].join('\n\n') + '\n';
  return { subject, text };
}

/**
 * Evening job: emails each crew member their appointments for tomorrow (company time). One email per
 * member per local day, guarded by the audit log. No task, no steps.
 */
export async function runAgenda(deps: AppDeps, companyId: string, meta: JobMeta): Promise<void> {
  void meta;
  const ctx = systemCtx(companyId);

  const company = await withTenant(deps.pools, ctx, (tx) => agentCompanyFacts(tx, ctx));
  if (!company || (company.status !== 'active' && company.status !== 'trial')) return;
  if (!(await withTenant(deps.pools, ctx, (tx) => g1AgentOn(tx, ctx, 'scheduler')))) return;

  const tz = company.timeZone;
  const now = deps.clock.now();
  const today = localParts(now, tz).localDate;
  const tomorrow = zoneDayAfter(today);
  const from = zoneDayStart(tomorrow, tz);
  const to = zoneDayStart(zoneDayAfter(tomorrow), tz);
  const todayStart = zoneDayStart(today, tz);
  const todayEnd = from;

  // appointmentScope returns no filter for the system role, so this sees every appointment.
  const all = await withTenant(deps.pools, ctx, (tx) => listAppointments(tx, ctx, { from, to }));
  const mine = all.filter((a): a is AppointmentView & { assigned: NonNullable<AppointmentView['assigned']> } =>
    a.assigned !== null && a.status === 'scheduled',
  );
  if (mine.length === 0) return;

  const groups = new Map<string, typeof mine>();
  for (const a of mine) {
    const g = groups.get(a.assigned.userId);
    if (g) g.push(a);
    else groups.set(a.assigned.userId, [a]);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  const customerIds = [...new Set(mine.flatMap((a) => (a.customerId ? [a.customerId] : [])))];
  const { members, phones } = await withTenant(deps.pools, ctx, async (tx) => ({
    members: await agendaMembers(tx, ctx, [...groups.keys()]),
    phones: await customerPhones(tx, ctx, customerIds),
  }));

  // C1 has no per-member email preference, so every member with visits gets the agenda (carry).
  const errors: unknown[] = [];
  for (const member of members) {
    try {
      const already = await withTenant(deps.pools, ctx, (tx) => agendaSentBetween(tx, ctx, member.userId, todayStart, todayEnd));
      if (already) continue;
      const visits = groups.get(member.userId) ?? [];
      if (visits.length === 0) continue;
      const { subject, text } = buildAgendaEmail({
        name: member.name,
        day: tomorrow,
        timeZone: tz,
        appOrigin: deps.config.APP_ORIGIN,
        visits: visits.map((a) => ({
          startsAt: a.startsAt,
          allDay: a.allDay,
          kind: a.kind,
          customerName: a.customerName,
          addressLine: a.addressLine,
          phone: a.customerId ? (phones.get(a.customerId) ?? null) : null,
          notes: a.notes,
          jobId: a.jobId,
        })),
      });
      await deps.mailer.send({ to: member.email, subject, text });
      await withTenant(deps.pools, ctx, (tx) => recordAgendaSent(tx, ctx, member.userId, today, now));
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) throw errors[0];
}

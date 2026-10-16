import {
  getProperty,
  listAppointmentsForCustomer,
  listJobs,
  loadCompanyFacts,
  proposalStatusForJob,
  withTenant,
} from '@roofline/db';
import type { JobStage } from '@roofline/shared';
import type { ToolHandler } from '../engine-types.ts';
import { systemCtx } from './system-ctx.ts';
import { whenWords } from './times.ts';

/*
 * D1 Task 7: lookup_my_jobs. Company and customer come from the conversation, never the model.
 * A caller who is only phone-matched hears the weekday of the next appointment and nothing else.
 * A verified caller's upcoming appointments are listed with their ids (for the model only) and added
 * to shownIds, so confirm_appointment, move_inspection and cancel_inspection can act on them.
 */

const MAX_JOBS = 5;
const MAX_APPOINTMENTS = 10;
const NO_CUSTOMER = "I don't have a customer record for this caller yet.";
const NO_APPOINTMENT = 'There is no upcoming appointment on file for this caller.';
const NO_JOBS = 'There are no jobs on file for this caller.';
const APPOINTMENT_NOTE =
  'Use an appointment id only in confirm_appointment, move_inspection or cancel_inspection. Say the visit and its time in words, never the id.';

const KIND_WORD: Record<string, string> = {
  inspection: 'inspection',
  install: 'install',
  adjuster: 'adjuster visit',
  other: 'visit',
};

function weekday(at: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long' }).format(at);
}

function monthDay(at: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric' }).format(at);
}

function stageWords(stage: JobStage, proposal: 'sent' | 'viewed' | 'signed' | null): string {
  switch (stage) {
    case 'lead':
      return 'new, waiting on an inspection to be set up';
    case 'inspection':
      return 'inspection stage';
    case 'proposal':
      return proposal === 'sent' || proposal === 'viewed' ? "waiting on the customer's signature" : 'the proposal is being prepared';
    case 'won':
      return 'approved and being scheduled';
    case 'installed':
      return 'installed';
    case 'lost':
      return 'closed';
  }
}

function proposalWords(proposal: 'sent' | 'viewed' | 'signed' | null): string | null {
  if (proposal === 'sent') return 'proposal sent';
  if (proposal === 'viewed') return 'proposal sent and opened';
  if (proposal === 'signed') return 'proposal signed';
  return null;
}

export const lookupMyJobs: ToolHandler<'lookup_my_jobs'> = async (ctx) => {
  const customerId = ctx.conversation.customerId;
  if (customerId === null) return { ok: false, forModel: NO_CUSTOMER };
  const tctx = systemCtx(ctx.companyId);
  const verified = ctx.conversation.identity === 'verified';

  return withTenant(ctx.deps.pools, tctx, async (tx) => {
    const { timezone } = await loadCompanyFacts(tx, tctx);
    const upcoming = await listAppointmentsForCustomer(tx, tctx, customerId, verified ? 50 : 1, ctx.now);

    if (!verified) {
      const next = upcoming[0];
      if (!next) return { ok: true, forModel: NO_APPOINTMENT };
      return { ok: true, forModel: `You have an appointment on ${weekday(new Date(next.startsAt), timezone)}.` };
    }

    const { jobs } = await listJobs(tx, tctx, { customerId, limit: MAX_JOBS });
    if (jobs.length === 0 && upcoming.length === 0) return { ok: true, forModel: NO_JOBS };
    const lines: string[] = [];
    for (const job of jobs) {
      const property = await getProperty(tx, tctx, job.propertyId);
      const proposal = await proposalStatusForJob(tx, tctx, job.id, ctx.now);
      const parts = [stageWords(job.stage, proposal)];
      const pw = proposalWords(proposal);
      if (pw !== null) parts.push(pw);
      const next = upcoming.find((a) => a.jobId === job.id);
      let nextText = 'none';
      if (next) {
        const when = `${weekday(new Date(next.startsAt), timezone)}, ${monthDay(new Date(next.startsAt), timezone)}`;
        const rep = next.assigned?.name.trim().split(/\s+/)[0];
        nextText = rep ? `inspection or visit on ${when} with ${rep}` : `visit on ${when}`;
      }
      lines.push(`Job ${job.id} at ${property?.addressLine ?? 'the property'}: ${parts.join('; ')}. Next: ${nextText}.`);
    }
    if (jobs.length === 0) lines.push(NO_JOBS);
    const listed = upcoming.slice(0, MAX_APPOINTMENTS);
    for (const a of listed) {
      const at = new Date(a.startsAt);
      const when = a.allDay ? `${weekday(at, timezone)}, ${monthDay(at, timezone)}` : whenWords(at, timezone);
      const rep = a.assigned?.name.trim().split(/\s+/)[0];
      const extras = [rep ? `with ${rep}` : null, a.addressLine ? `at ${a.addressLine}` : null, a.confirmedAt !== null ? 'confirmed' : 'not confirmed yet'];
      lines.push(`Appointment ${a.id}: ${KIND_WORD[a.kind] ?? 'visit'} on ${when}, ${extras.filter((x) => x !== null).join(', ')}.`);
    }
    if (listed.length > 0) lines.push(APPOINTMENT_NOTE);
    const shown = [
      ...jobs.flatMap((j) => [j.id, j.propertyId]),
      ...listed.flatMap((a) => (a.propertyId !== null ? [a.id, a.propertyId] : [a.id])),
    ];
    return { ok: true, forModel: lines.join('\n'), shownIds: [...new Set(shown)] };
  });
};

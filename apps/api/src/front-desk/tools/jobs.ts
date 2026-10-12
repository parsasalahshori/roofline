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

/*
 * D1 Task 7: lookup_my_jobs. Company and customer come from the conversation, never the model.
 * A caller who is only phone-matched hears the weekday of the next appointment and nothing else.
 */

const MAX_JOBS = 5;
const NO_CUSTOMER = "I don't have a customer record for this caller yet.";
const NO_APPOINTMENT = 'There is no upcoming appointment on file for this caller.';
const NO_JOBS = 'There are no jobs on file for this caller.';

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
    if (jobs.length === 0) return { ok: true, forModel: NO_JOBS };
    const lines: string[] = [];
    for (const job of jobs) {
      const property = await getProperty(tx, tctx, job.propertyId);
      const proposal = await proposalStatusForJob(tx, tctx, job.id);
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
    return { ok: true, forModel: lines.join('\n'), shownIds: [...new Set(jobs.flatMap((j) => [j.id, j.propertyId]))] };
  });
};

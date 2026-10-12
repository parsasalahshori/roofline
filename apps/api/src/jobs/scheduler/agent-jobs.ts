import { companySettings, withTenant } from '@roofline/db';
import { companiesForAgentJobs } from '@roofline/db/system';
import { localParts, dueNow, type AgentJob } from '../../agents/schedule.ts';
import type { AppDeps } from '../../app.ts';
import { systemContext } from '../../permissions.ts';
import { reportJobError } from './report.ts';

/** A company's reminder hour, read as the company (app_system cannot read company_settings). Default 15. */
async function reminderHourOf(deps: AppDeps, companyId: string): Promise<number> {
  const rows = await withTenant(deps.pools, systemContext(companyId), (tx) =>
    tx.select({ hour: companySettings.reminderHour }).from(companySettings).limit(1),
  );
  return rows[0]?.hour ?? 15;
}

/**
 * The scheduled run for one agent job: for each active company whose local time is in the job's
 * window, sends the job once with a singletonKey for that local day (and hour, for weather). One
 * company failing is logged and does not stop the others.
 */
export function agentJobSchedule(job: AgentJob): (deps: AppDeps, now: Date) => Promise<void> {
  return async (deps, now) => {
    const list = await companiesForAgentJobs(deps.pools.system);
    for (const company of list) {
      try {
        let parts: ReturnType<typeof localParts>;
        try {
          parts = localParts(now, company.timeZone);
        } catch {
          continue; // an unknown time zone: skip the company
        }
        // Only the quarter hour of a run reads anything: reminders look up the company's own hour.
        if (job === 'scheduler-reminders' && parts.minute >= 15) continue;
        const reminderHour = job === 'scheduler-reminders' ? await reminderHourOf(deps, company.id) : 15;
        if (!dueNow(job, now, company.timeZone, reminderHour)) continue;
        const slot = job === 'scheduler-weather' ? `${parts.localDate}T${String(parts.hour).padStart(2, '0')}` : parts.localDate;
        await deps.jobs.send(job, { companyId: company.id }, { singletonKey: `${job}:${company.id}:${slot}` });
      } catch (err) {
        reportJobError(deps, err, `${job}: company ${company.id}`);
      }
    }
  };
}

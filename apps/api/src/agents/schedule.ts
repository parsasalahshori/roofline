/*
 * When each G1 agent job runs for a company: at fixed hours of the company's own clock. The worker
 * ticks every 15 minutes; a job is due in the first quarter hour of its hour, so one tick falls in
 * its window. The singletonKey on the send (job, company, local date, and hour for the weather job)
 * collapses sends while a matching job is still queued or running; after it finishes, a late or
 * doubled tick could queue it again, so each handler must be idempotent per local day (Tasks 8, 10,
 * 11, 13).
 */

export type AgentJob = 'claims-daily' | 'scheduler-reminders' | 'scheduler-agenda' | 'scheduler-weather' | 'followup-daily';

/** The company-local hours each job runs at; reminders read company_settings.reminder_hour (default 15). */
export const AGENT_JOB_HOURS: Record<Exclude<AgentJob, 'scheduler-reminders'>, readonly number[]> = {
  'claims-daily': [10],
  'scheduler-agenda': [18],
  'scheduler-weather': [6, 14],
  'followup-daily': [9],
};

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    FORMATTERS.set(timeZone, f);
  }
  return f;
}

/** The company-local date (YYYY-MM-DD), hour (0-23) and minute at `now`. Throws RangeError for an unknown time zone. */
export function localParts(now: Date, timeZone: string): { localDate: string; hour: number; minute: number } {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(now)) parts[p.type] = p.value;
  const hour = Number(parts.hour) % 24;
  return { localDate: `${parts.year}-${parts.month}-${parts.day}`, hour, minute: Number(parts.minute) };
}

/** True when the company-local time is in [hh:00, hh:15) for one of the job's hours. */
export function dueNow(job: AgentJob, now: Date, timeZone: string, reminderHour: number): boolean {
  const hours = job === 'scheduler-reminders' ? [reminderHour] : AGENT_JOB_HOURS[job];
  const { hour, minute } = localParts(now, timeZone);
  return hours.includes(hour) && minute >= 0 && minute < 15;
}

// agentJobSchedule (the worker's run for each job) lives in jobs/scheduler/agent-jobs.ts: it reads the
// company list with @roofline/db/system, which lint allows only under the scheduler's folder.

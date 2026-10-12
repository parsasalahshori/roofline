import type { AppDeps } from '../app.ts';
import { advanceRegistration } from '../account/texting/advance.ts';
import { runClaimsDaily } from '../agents/claims/nudges.ts';
import { runClaimsReply } from '../agents/claims/replies.ts'; // G1 Task 8
import { runFollowUps } from '../agents/followup/daily.ts';
import { runAgenda } from '../agents/scheduler/agenda.ts';
import { runNoShow } from '../agents/scheduler/no-show.ts'; // G1 Task 12
import { runReminders } from '../agents/scheduler/reminders.ts';
import { runWeatherWatch } from '../agents/scheduler/weather.ts';
import { pushAppointment } from '../calendar/push.ts';
import { loadFootprintState } from '../estimator/footprints-load.ts';
import { signedPdf } from '../estimator/signed-pdf.ts';
import { runImport } from '../imports/run.ts';
import type { JobName, JobData, JobMeta } from './queue.ts';

/**
 * What each job does, by name. The worker (worker.ts) and `InlineJobs.drain` both run jobs through
 * this map. Imports only types from queue.ts, so the two files can refer to each other.
 */
export const JOB_HANDLERS: Record<JobName, (deps: AppDeps, data: JobData, meta: JobMeta) => Promise<void>> = {
  'import-customers': (deps, data, meta) => runImport(deps, data.companyId, data.importId!, meta),
  'texting-registration': (deps, data) => advanceRegistration(deps, data.companyId),
  'calendar-push': (deps, data, meta) => pushAppointment(deps, data.companyId, data.appointmentId!, meta),
  // D1 Front Desk
  'fd-after-call': async () => {}, // Task 12 fills this in
  'fd-recording-store': async () => {}, // Task 12 fills this in
  'fd-text': async () => {}, // Task 14 fills this in
  'fd-forwarding-test': async () => {}, // Task 17 fills this in
  // G1 Agents
  'claims-daily': (deps, data, meta) => runClaimsDaily(deps, data.companyId, meta),
  'scheduler-reminders': (deps, data, meta) => runReminders(deps, data.companyId, meta),
  'scheduler-agenda': (deps, data, meta) => runAgenda(deps, data.companyId, meta),
  'scheduler-weather': (deps, data, meta) => runWeatherWatch(deps, data.companyId, meta),
  'followup-daily': (deps, data, meta) => runFollowUps(deps, data.companyId, meta),
  // G1 Task 8
  'claims-reply': (deps, data) => runClaimsReply(deps, data.companyId, data.messageId!),
  // G1 Task 12
  'scheduler-no-show': (deps, data) => runNoShow(deps, data.companyId, data.appointmentId!),
  'footprints-load': (deps, data, meta) => loadFootprintState(deps, data.state!, meta),
  'signed-pdf': (deps, data) => signedPdf(deps, data.companyId, data.proposalId!),
};

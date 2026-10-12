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
import { makeSignedPdf } from '../estimator/signed-pdf.ts';
import { runAfterCall } from '../front-desk/after-call.ts';
import { expireForwardingTest } from '../front-desk/forwarding-test.ts';
import { runFrontDeskText } from '../front-desk/texts.ts';
import { runImport } from '../imports/run.ts';
import { syncCompanyAds } from '../storm/ad-sync.ts';
import { sendStormAlert } from '../storm/alerts.ts';
import { matchCompanyStorms } from '../storm/match.ts';
import { draftStormPlan } from '../storm/plan.ts';
import { PLAN_DISMISSED, PLAN_NOT_FOUND } from '../storm/plan-errors.ts';
import { UUID } from '../validate.ts';
import { reportJobError } from './scheduler/report.ts';
import { storeRecording } from './recording-store.ts';
import type { JobName, JobData, JobMeta } from './queue.ts';

function checkStormJob(data: JobData): void {
  if (typeof data.companyStormId !== 'string' || !UUID.test(data.companyStormId)) {
    throw new Error('A storm job did not name a company storm.');
  }
}

function checkStormAlertJob(data: JobData): void {
  checkStormJob(data);
  if (data.kind !== 'now' && data.kind !== 'plan') throw new Error('A storm alert job did not name a kind.');
}

async function runStormDraft(deps: AppDeps, data: JobData): Promise<void> {
  try {
    await draftStormPlan(deps, data.companyId, data.companyStormId!, deps.clock.now());
  } catch (err) {
    // An unknown or dismissed storm never becomes draftable by retrying: log it and drop the job.
    if (err instanceof Error && (err.message === PLAN_NOT_FOUND || err.message === PLAN_DISMISSED)) {
      reportJobError(deps, err, `storm-draft: company storm ${data.companyStormId}`);
      return;
    }
    throw err;
  }
}

/**
 * What each job does, by name. The worker (worker.ts) and `InlineJobs.drain` both run jobs through
 * this map. Imports only types from queue.ts, so the two files can refer to each other.
 */
export const JOB_HANDLERS: Record<JobName, (deps: AppDeps, data: JobData, meta: JobMeta) => Promise<void>> = {
  'import-customers': (deps, data, meta) => runImport(deps, data.companyId, data.importId!, meta),
  'texting-registration': (deps, data) => advanceRegistration(deps, data.companyId),
  'calendar-push': (deps, data, meta) => pushAppointment(deps, data.companyId, data.appointmentId!, meta),
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
  'signed-pdf': (deps, data, meta) => makeSignedPdf(deps, data.companyId, data.proposalId!, meta),
  'storm-match-company': (deps, data) => matchCompanyStorms(deps, data.companyId),
  'storm-draft': (deps, data) => {
    checkStormJob(data);
    return runStormDraft(deps, data);
  },
  'storm-alert': (deps, data) => {
    checkStormAlertJob(data);
    return sendStormAlert(deps, data.companyId, data.companyStormId!, data.kind!);
  },
  'ad-sync-company': (deps, data) => syncCompanyAds(deps, data.companyId),
  // D1 Front Desk
  'fd-after-call': (deps, data) => runAfterCall(deps, data),
  'fd-recording-store': (deps, data, meta) => storeRecording(deps, data, meta),
  'fd-text': (deps, data) => runFrontDeskText(deps, data),
  'fd-forwarding-test': (deps, data) => expireForwardingTest(deps, data.companyId, data.testId!),
};

import type { AppDeps } from '../app.ts';
import { advanceRegistration } from '../account/texting/advance.ts';
import { pushAppointment } from '../calendar/push.ts';
import { loadFootprintState } from '../estimator/footprints-load.ts';
import { signedPdf } from '../estimator/signed-pdf.ts';
import { runAfterCall } from '../front-desk/after-call.ts';
import { expireForwardingTest } from '../front-desk/forwarding-test.ts';
import { runFrontDeskText } from '../front-desk/texts.ts';
import { runImport } from '../imports/run.ts';
import { syncCompanyAds } from '../storm/ad-sync.ts';
import { sendStormAlert } from '../storm/alerts.ts';
import { matchCompanyStorms } from '../storm/match.ts';
import { draftStormPlan } from '../storm/plan.ts';
import { UUID } from '../validate.ts';
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

/**
 * What each job does, by name. The worker (worker.ts) and `InlineJobs.drain` both run jobs through
 * this map. Imports only types from queue.ts, so the two files can refer to each other.
 */
export const JOB_HANDLERS: Record<JobName, (deps: AppDeps, data: JobData, meta: JobMeta) => Promise<void>> = {
  'import-customers': (deps, data, meta) => runImport(deps, data.companyId, data.importId!, meta),
  'texting-registration': (deps, data) => advanceRegistration(deps, data.companyId),
  'calendar-push': (deps, data, meta) => pushAppointment(deps, data.companyId, data.appointmentId!, meta),
  'footprints-load': (deps, data, meta) => loadFootprintState(deps, data.state!, meta),
  'signed-pdf': (deps, data) => signedPdf(deps, data.companyId, data.proposalId!),
  'storm-match-company': (deps, data) => matchCompanyStorms(deps, data.companyId),
  'storm-draft': (deps, data) => {
    checkStormJob(data);
    return draftStormPlan(deps, data.companyId, data.companyStormId!, deps.clock.now()).then(() => undefined);
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

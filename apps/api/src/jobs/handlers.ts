import type { AppDeps } from '../app.ts';
import { advanceRegistration } from '../account/texting/advance.ts';
import { pushAppointment } from '../calendar/push.ts';
import { signedPdf } from '../estimator/signed-pdf.ts';
import { runImport } from '../imports/run.ts';
import { syncCompanyAds } from '../storm/ad-sync.ts';
import { sendStormAlert } from '../storm/alerts.ts';
import { matchCompanyStorms } from '../storm/match.ts';
import { draftStormPlan } from '../storm/plan.ts';
import type { JobName, JobData, JobMeta } from './queue.ts';

/**
 * What each job does, by name. The worker (worker.ts) and `InlineJobs.drain` both run jobs through
 * this map. Imports only types from queue.ts, so the two files can refer to each other.
 */
export const JOB_HANDLERS: Record<JobName, (deps: AppDeps, data: JobData, meta: JobMeta) => Promise<void>> = {
  'import-customers': (deps, data, meta) => runImport(deps, data.companyId, data.importId!, meta),
  'texting-registration': (deps, data) => advanceRegistration(deps, data.companyId),
  'calendar-push': (deps, data, meta) => pushAppointment(deps, data.companyId, data.appointmentId!, meta),
  // E1 Task 6 replaces this: loads one state's building footprints.
  'footprints-load': async () => {
    throw new Error('not yet');
  },
  'signed-pdf': (deps, data) => signedPdf(deps, data.companyId, data.proposalId!),
  'storm-match-company': (deps, data) => matchCompanyStorms(deps, data.companyId),
  'storm-draft': (deps, data) => draftStormPlan(deps, data.companyId, data.companyStormId!),
  'storm-alert': (deps, data) => sendStormAlert(deps, data.companyId, data.companyStormId!, data.kind!),
  'ad-sync-company': (deps, data) => syncCompanyAds(deps, data.companyId),
};

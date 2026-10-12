import type { AppDeps } from '../app.ts';
import { advanceRegistration } from '../account/texting/advance.ts';
import { runAfterCall } from '../front-desk/after-call.ts';
import { expireForwardingTest } from '../front-desk/forwarding-test.ts';
import { runFrontDeskText } from '../front-desk/texts.ts';
import { runImport } from '../imports/run.ts';
import { storeRecording } from './recording-store.ts';
import type { JobName, JobData, JobMeta } from './queue.ts';

/**
 * What each job does, by name. The worker (worker.ts) and `InlineJobs.drain` both run jobs through
 * this map. Imports only types from queue.ts, so the two files can refer to each other.
 */
export const JOB_HANDLERS: Record<JobName, (deps: AppDeps, data: JobData, meta: JobMeta) => Promise<void>> = {
  'import-customers': (deps, data, meta) => runImport(deps, data.companyId, data.importId!, meta),
  'texting-registration': (deps, data) => advanceRegistration(deps, data.companyId),
  // D1 Front Desk
  'fd-after-call': (deps, data) => runAfterCall(deps, data),
  'fd-recording-store': (deps, data, meta) => storeRecording(deps, data, meta),
  'fd-text': (deps, data) => runFrontDeskText(deps, data),
  'fd-forwarding-test': (deps, data) => expireForwardingTest(deps, data.companyId, data.testId!),
};

/* eslint-disable @typescript-eslint/no-unused-vars -- placeholder: its parameters are used when the real body lands */
import type { AppDeps } from '../app.ts';
import type { JobMeta } from '../jobs/queue.ts';

/** Pushes one appointment to the people's connected calendars (C1 Task 13). Placeholder: does nothing. */
export async function pushAppointment(_deps: AppDeps, _companyId: string, _appointmentId: string, _meta: JobMeta): Promise<void> {}

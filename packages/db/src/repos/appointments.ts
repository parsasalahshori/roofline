/* eslint-disable @typescript-eslint/no-unused-vars -- placeholder: its parameters are used when the real body lands */
import type { AppointmentView } from '@roofline/shared';
import type { TenantContext, Tx } from '../tenant.ts';

// placeholder: Task 8 replaces the body (appointments for a job, and for a customer's upcoming list).

/** Appointments on one job, oldest first. Placeholder: returns none until Task 8. */
export async function listAppointmentsForJob(_tx: Tx, _ctx: TenantContext, _jobId: string): Promise<AppointmentView[]> {
  return [];
}

/** A customer's upcoming appointments, at most `limit`, from `now`. Placeholder: returns none until Task 8. */
export async function listAppointmentsForCustomer(
  _tx: Tx,
  _ctx: TenantContext,
  _customerId: string,
  _limit: number,
  _now: Date,
): Promise<AppointmentView[]> {
  return [];
}

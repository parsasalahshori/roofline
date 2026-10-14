import type { NewCustomerInput } from '../estimator/types.ts';

/**
 * What the window that opened the measure window passes in router state: the job to keep, or the new customer to
 * create; `autoScan` when the person already pressed Measure (the scan plays without a second press).
 */
export type MeasureHandoff = { jobId?: string; customer?: NewCustomerInput; autoScan?: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Reads router state defensively: anything of the wrong shape is ignored, never trusted. */
export function readHandoff(state: unknown): MeasureHandoff {
  if (!isRecord(state)) return {};
  const out: MeasureHandoff = {};
  if (typeof state.jobId === 'string' && state.jobId !== '') out.jobId = state.jobId;
  if (state.autoScan === true) out.autoScan = true;
  const c = state.customer;
  if (isRecord(c) && typeof c.name === 'string' && typeof c.phone === 'string' && typeof c.askedByText === 'boolean') {
    out.customer = {
      name: c.name,
      phone: c.phone,
      ...(typeof c.email === 'string' && c.email !== '' && { email: c.email }),
      askedByText: c.askedByText,
    };
  }
  return out;
}

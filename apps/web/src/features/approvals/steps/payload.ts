import type { StepView } from '../../../api/types.ts';

export const DEFAULT_ZONE = 'America/Chicago';

export type Payload = Record<string, unknown>;

/** The step's payload as an object. A payload that is missing or not an object reads as empty. */
export function payloadOf(step: StepView): Payload {
  const payload: unknown = step.payload;
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Payload) : {};
}

export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

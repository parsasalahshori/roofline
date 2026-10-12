import { activeLeak } from './active-leak.ts';
import { angryCaller } from './angry-caller.ts';
import { booking } from './booking.ts';
import { bookingTakenSlot } from './booking-taken-slot.ts';
import { claim } from './claim.ts';
import { insuranceCoverage } from './insurance-coverage.ts';
import { jobUnverified } from './job-unverified.ts';
import { jobVerified } from './job-verified.ts';
import { price } from './price.ts';
import { promptInjection } from './prompt-injection.ts';
import { ramblingCaller } from './rambling-caller.ts';
import { recordingObjection } from './recording-objection.ts';
import { spamPitch } from './spam-pitch.ts';
import type { Scenario } from './types.ts';

/** Spec section 16, "Scripted call evals": every listed call, in the order the spec lists them. */
export const SCENARIOS: readonly Scenario[] = [
  booking,
  bookingTakenSlot,
  jobVerified,
  jobUnverified,
  claim,
  price,
  insuranceCoverage,
  angryCaller,
  activeLeak,
  spamPitch,
  recordingObjection,
  promptInjection,
  ramblingCaller,
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

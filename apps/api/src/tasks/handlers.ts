import type { StepType } from '@roofline/shared';
import { createAppointmentStep, moveAppointmentStep } from '../agents/appointments-steps.ts'; // G1 Task 8
import { sendPersonalTexts } from '../agents/personal-texts.ts';
import { orderExactReport } from '../estimator/exact-report.ts';
import { sendSmsBatch } from '../messaging/send-batch.ts';
import { sendProposalStep } from '../estimator/send-proposal.ts';
import type { StepHandler } from './runner.ts';

/** The demo steps (the F2 demo task, and the tests) do nothing and finish at once. */
const finishAtOnce: StepHandler = async () => ({ status: 'done', result: { ok: 1 } });

/** A G1 step whose handler has not landed: it fails, so an approved step never silently succeeds. */
const notBuilt: StepHandler = async () => ({ status: 'failed', result: {}, errorPlain: 'Not built yet.' });

/**
 * What runs each kind of step, as the platform ships it; runner.ts starts from this. A type with
 * no handler here cannot run yet: its step needs attention ("This kind of step can't run yet.").
 * `send_sms_batch` texts its customers through the send gate (messaging/send-batch.ts).
 */
export const builtInHandlers: Partial<Record<StepType, StepHandler>> = {
  demo_noop: finishAtOnce,
  demo_message: finishAtOnce,
  demo_spend: finishAtOnce,
  send_sms_batch: sendSmsBatch,
  // G1 Agents
  send_personal_texts: sendPersonalTexts,
  build_claim_packet: notBuilt, // G1 Task 7 fills this in
  create_appointment: createAppointmentStep, // G1 Task 8
  move_appointment: moveAppointmentStep, // G1 Task 11
  send_proposal: sendProposalStep,
  order_exact_report: orderExactReport,
};

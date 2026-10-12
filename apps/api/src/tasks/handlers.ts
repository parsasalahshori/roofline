import type { StepType } from '@roofline/shared';
import { sendSmsBatch } from '../messaging/send-batch.ts';
import { sendProposalStep } from '../estimator/send-proposal.ts';
import type { StepHandler } from './runner.ts';

/** The demo steps (the F2 demo task, and the tests) do nothing and finish at once. */
const finishAtOnce: StepHandler = async () => ({ status: 'done', result: { ok: 1 } });

/** Steps whose real handler arrives in a later E1 task fail until then (the runner reports the step). */
const notYet: StepHandler = async () => {
  throw new Error('not yet');
};

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
  send_proposal: sendProposalStep,
  order_exact_report: notYet,
};

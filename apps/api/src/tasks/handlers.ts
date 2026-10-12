import type { StepType } from '@roofline/shared';
import { orderExactReport } from '../estimator/exact-report.ts';
import { sendSmsBatch } from '../messaging/send-batch.ts';
import { sendProposalStep } from '../estimator/send-proposal.ts';
import { sendEmailBatchHandler } from '../storm/email-batch.ts';
import { buildRoutesHandler } from '../storm/routes-build.ts';
import type { StepHandler } from './runner.ts';

/** The demo steps (the F2 demo task, and the tests) do nothing and finish at once. */
const finishAtOnce: StepHandler = async () => ({ status: 'done', result: { ok: 1 } });

/** Steps whose real handler arrives in a later task fail until then (the runner reports the step). */
const notYet: StepHandler = async () => {
  throw new Error('not yet');
};

/**
 * What runs each kind of step, as the platform ships it; runner.ts starts from this. A type with
 * no handler here cannot run yet: its step needs attention ("This kind of step can't run yet.").
 * The Storm Scout step `create_ad_campaign` fails with 'not yet' until its handler lands.
 * `send_sms_batch` texts its customers through the send gate (messaging/send-batch.ts).
 * `send_email_batch` emails them through the email gate (storm/email-batch.ts).
 * `build_routes` turns a storm's hail zone into door-knock routes (storm/routes-build.ts).
 */
export const builtInHandlers: Partial<Record<StepType, StepHandler>> = {
  demo_noop: finishAtOnce,
  demo_message: finishAtOnce,
  demo_spend: finishAtOnce,
  send_sms_batch: sendSmsBatch,
  send_proposal: sendProposalStep,
  order_exact_report: orderExactReport,
  // Storm Scout (S1): `create_ad_campaign`'s real handler arrives in a later S1 task.
  send_email_batch: sendEmailBatchHandler,
  build_routes: buildRoutesHandler,
  create_ad_campaign: notYet,
};

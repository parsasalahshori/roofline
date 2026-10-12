import type { StepType } from '@roofline/shared';
import { orderExactReport } from '../estimator/exact-report.ts';
import { sendProposalStep } from '../estimator/send-proposal.ts';
import { sendSmsBatch } from '../messaging/send-batch.ts';
import { createAdCampaignHandler } from '../storm/ad-campaign.ts';
import { sendEmailBatchHandler } from '../storm/email-batch.ts';
import { buildRoutesHandler } from '../storm/routes-build.ts';
import type { StepHandler } from './runner.ts';

/** The demo steps (the F2 demo task, and the tests) do nothing and finish at once. */
const finishAtOnce: StepHandler = async () => ({ status: 'done', result: { ok: 1 } });

/**
 * What runs each kind of step, as the platform ships it; runner.ts starts from this. A type with
 * no handler here cannot run yet: its step needs attention ("This kind of step can't run yet.").
 * `send_proposal` texts or emails a proposal link (estimator/send-proposal.ts); `order_exact_report`
 * orders an exact roof report (estimator/exact-report.ts).
 * `send_sms_batch` texts its customers through the send gate (messaging/send-batch.ts).
 * `send_email_batch` emails them through the email gate (storm/email-batch.ts).
 * `create_ad_campaign` makes a paused ad campaign at the approved maximum, then enables it (storm/ad-campaign.ts).
 * `build_routes` turns a storm's hail zone into door-knock routes (storm/routes-build.ts).
 */
export const builtInHandlers: Partial<Record<StepType, StepHandler>> = {
  demo_noop: finishAtOnce,
  demo_message: finishAtOnce,
  demo_spend: finishAtOnce,
  send_sms_batch: sendSmsBatch,
  send_proposal: sendProposalStep,
  order_exact_report: orderExactReport,
  // Storm Scout (S1)
  send_email_batch: sendEmailBatchHandler,
  build_routes: buildRoutesHandler,
  create_ad_campaign: createAdCampaignHandler,
};

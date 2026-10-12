import type { StepView } from '../../../api/types.ts';
import { adCampaignKit } from './AdCampaignPreview.tsx';
import { buildRoutesKit } from './BuildRoutesPreview.tsx';
import { emailBatchKit } from './EmailBatchPreview.tsx';
import type { StepKit, StepKits } from './types.ts';

export type { EditFieldSpec, EditValues, StepKit, StepPreviewProps } from './types.ts';

/** The review kit per step type (Ruling SD). A type not listed here keeps the plain review and the plain text edit. */
export const stepKits: StepKits = {
  send_email_batch: emailBatchKit,
  build_routes: buildRoutesKit,
  create_ad_campaign: adCampaignKit,
};

export function kitFor(step: Pick<StepView, 'type'>): StepKit | undefined {
  return stepKits[step.type];
}

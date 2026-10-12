import type { StepView } from '../../../api/types.ts';
import { adCampaignKit } from './AdCampaignPreview.tsx';
import { buildRoutesKit } from './BuildRoutesPreview.tsx';
import { claimPacketKit } from './ClaimPacketPreview.tsx';
import { createAppointmentKit } from './AppointmentPreview.tsx';
import { emailBatchKit } from './EmailBatchPreview.tsx';
import { moveAppointmentKit } from './MoveAppointmentPreview.tsx';
import { sendTextsKit } from './SendTextsPreview.tsx';
import type { StepKit, StepKits } from './types.ts';

export type { EditFieldSpec, EditValues, StepKit, StepKitContext, StepPreviewProps } from './types.ts';

/** The review kit per step type (Ruling SD). A type not listed here keeps the plain review and the plain text edit. */
export const stepKits: StepKits = {
  send_email_batch: emailBatchKit,
  build_routes: buildRoutesKit,
  create_ad_campaign: adCampaignKit,
  // G1 Task 17p
  send_personal_texts: sendTextsKit,
  build_claim_packet: claimPacketKit,
  create_appointment: createAppointmentKit,
  move_appointment: moveAppointmentKit,
};

export function kitFor(step: Pick<StepView, 'type'>): StepKit | undefined {
  return stepKits[step.type];
}

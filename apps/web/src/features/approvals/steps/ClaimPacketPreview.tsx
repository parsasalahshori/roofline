import { Button } from '@roofline/ui';
import { stepVisits } from '../../../copy/stepVisits.ts';
import { payloadOf } from './payload.ts';
import type { StepKit, StepPreviewProps } from './types.ts';

/** The claim packet under a build_claim_packet step: what it builds and a way to the job. */
export function ClaimPacketPreview({ step }: StepPreviewProps) {
  const jobId = payloadOf(step).jobId;
  return (
    <div>
      <p>{stepVisits.packetBlurb}</p>
      {typeof jobId === 'string' && jobId !== '' ? (
        <Button variant="ghost" href={`/jobs/${jobId}`}>
          {stepVisits.openJob}
        </Button>
      ) : null}
    </div>
  );
}

export const claimPacketKit: StepKit = {
  Preview: ClaimPacketPreview,
  review: (step) => ({ ...step.preview }),
  editFields: () => [],
  toPayload: (step) => ({ ...payloadOf(step) }),
};

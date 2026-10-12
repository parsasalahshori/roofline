import { Button } from '@roofline/ui';
import { stepVisits } from '../../../copy/stepVisits.ts';
import type { StepView } from '../../../api/types.ts';
import type { StepKit, StepPreviewProps } from './types.ts';

type Payload = Record<string, unknown>;

function payloadOf(step: StepView): Payload {
  const payload: unknown = step.payload;
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Payload) : {};
}

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

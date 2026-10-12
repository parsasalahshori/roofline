import type { ClaimEventActor, ClaimStatus } from './more-agents.ts';

export type ClaimView = {
  id: string;
  jobId: string;
  insurer: string | null;
  claimNumber: string | null;
  dateOfLoss: string | null;
  status: ClaimStatus;
  adjusterName: string | null;
  adjusterPhone: string | null;
  adjusterEmail: string | null;
  adjusterAppointmentId: string | null;
  deductibleCents: number | null;
  notes: string | null;
  statusChangedAt: string;
  events: { from: ClaimStatus | null; to: ClaimStatus; by: ClaimEventActor; byName: string | null; at: string }[];
};
export type ClaimIntakeView = {
  insurer: string;
  claimNumber: string | null;
  dateOfLoss: string | null;
  description: string;
  adjusterVisitAt: string | null;
};
/** intake = the latest D1 intake on the job, shown until a claim exists. */
export type JobClaimResponse = { claim: ClaimView | null; intake: ClaimIntakeView | null };
export type ClaimBoardRow = {
  claimId: string;
  jobId: string;
  customerName: string;
  address: string | null;
  status: ClaimStatus;
  insurer: string | null;
  claimNumber: string | null;
  statusChangedAt: string;
};
export const CLAIM_FIELD_LIMITS = { text: 200, notes: 2000 } as const;

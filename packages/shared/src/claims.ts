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
export type JobClaimResponse = {
  claim: ClaimView | null;
  intake: ClaimIntakeView | null;
  /** G1 Task 7: the latest built claim packet (stored_files kind 'claim_packet'); null until one is built or while there is no claim. */
  packet: ClaimPacketInfo | null;
};
/** G1 Task 7: the latest claim packet on a claim. `builtAt` is an ISO instant. */
export type ClaimPacketInfo = { storedFileId: string; builtAt: string };

/** G1 Task 7: everything the claim packet PDF prints, read by `getClaimPacketFacts` (packages/db/src/repos/claim-packet.ts). */
export type ClaimPacketFacts = {
  claimId: string;
  jobId: string;
  company: { name: string; phone: string | null };
  /** The company's IANA time zone. */
  timeZone: string;
  customerName: string;
  /** One line: "street, city, state zip". */
  address: string;
  /** [lng, lat] of the property, null when it has no point. */
  propertyCenter: [number, number] | null;
  insurer: string | null;
  claimNumber: string | null;
  /** YYYY-MM-DD or null. */
  dateOfLoss: string | null;
  /** Largest hail contour at the property on the date of loss (or the day before); null when none or no date of loss. */
  hail: { thresholdIn: number; convectiveDay: string } | null;
  /** Spotter reports within 10 miles on that day, sorted by size (largest first) then time, at most 10. `timeUtc` is HH:MM:SS. */
  spotterReports: { sizeIn: number; reportDate: string; timeUtc: string; location: string | null; county: string | null; state: string }[];
  /** The property's latest measurement; `label` is exactly "Estimate (aerial/footprint)" or "Exact report". */
  measurement: {
    kind: 'estimate' | 'exact';
    label: string;
    roofSquares: number | null;
    roofAreaSqFt: number | null;
    pitchX12: number | null;
    measuredAt: string;
  } | null;
  /** The latest completed inspection appointment on the job; `date` is an ISO instant. */
  inspection: { date: string; notes: string | null } | null;
  /** The promoted intake's description (claim_intakes), null when none. */
  intakeNotes: string | null;
};
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

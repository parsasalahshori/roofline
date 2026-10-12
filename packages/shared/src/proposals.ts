// scratch: E1 Task 1's shared slice written from the T1 brief so Wave 2 (T2-T4) can start before T1 merges.
// Merge rule: T1's proposals.ts constants block wins; T4's additions go below it.
export const MEASUREMENT_KINDS = ['estimate', 'exact'] as const;
export type MeasurementKind = (typeof MEASUREMENT_KINDS)[number];
export const MEASUREMENT_METHODS = ['outline', 'aerial', 'eagleview', 'manual'] as const;
export type MeasurementMethod = (typeof MEASUREMENT_METHODS)[number];
export const TIERS = ['good', 'better', 'best'] as const;
export type Tier = (typeof TIERS)[number];
export const ADD_ON_UNITS = ['per_square', 'per_edge_ft', 'per_ridge_ft', 'per_valley_ft', 'per_job'] as const;
export type AddOnUnit = (typeof ADD_ON_UNITS)[number];
export const PROPOSAL_STATUSES = ['draft', 'ready', 'sent', 'viewed', 'signed', 'declined', 'expired', 'replaced'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const PROPOSAL_EVENT_KINDS = ['sent', 'viewed', 'option_viewed', 'signed', 'declined', 'link_resent', 'link_copied'] as const;
export type ProposalEventKind = (typeof PROPOSAL_EVENT_KINDS)[number];
export const EXACT_ORDER_STATUSES = ['priced', 'ordering', 'waiting', 'complete', 'attention', 'canceled'] as const;
export type ExactOrderStatus = (typeof EXACT_ORDER_STATUSES)[number];
export const FOOTPRINT_STATE_STATUSES = ['loading', 'ready', 'failed'] as const;
export type FootprintStateStatus = (typeof FOOTPRINT_STATE_STATUSES)[number];
export const STORED_FILE_KINDS = ['signed_proposal_pdf'] as const;
export type StoredFileKind = (typeof STORED_FILE_KINDS)[number];

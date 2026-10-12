import type { ProposalStatus, ProposalView } from '@roofline/shared';

/** The list filter sent as `?status=&q=`; a missing field is left out of the query. */
export type ProposalFilter = { status?: ProposalStatus; q?: string };
export type ProposalList = { proposals: ProposalView[]; total: number };
/** The new-customer mini form, sent as `customer` on POST /api/proposals. */
export type NewCustomerInput = { name: string; phone: string; email?: string; askedByText: boolean };
/** What "Make proposal" works on: a saved home, or a typed address the server geocodes. */
export type MakeTarget = { kind: 'home'; propertyId: string; label: string } | { kind: 'address'; address: string };

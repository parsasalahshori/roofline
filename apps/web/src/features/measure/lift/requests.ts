import type { MeasurementKind, ProposalStatus, ProposalView } from '@roofline/shared';
import { useProposalGroup } from '../../estimator/api.ts';
import { measure } from '../../../copy/measure.ts';

export type RequestStatus = keyof typeof measure.status;

/** Proposals that still stand: replaced, declined and expired ones are not requests to work on. */
export const REQUEST_STATUSES: readonly ProposalStatus[] = ['draft', 'ready', 'sent', 'viewed', 'signed'];

export type RequestRow = {
  measurementId: string;
  /** The proposal behind the row; its own page stays reachable from the list once it is out or signed. */
  proposalId: string;
  /** The proposal number (P-0004), shown beside the address. */
  number: string;
  name: string;
  address: string;
  /** Roof material, when the proposal's first option says. */
  material: string | null;
  squares: number | null;
  status: RequestStatus;
};

/** Where a proposal stands as a lead: signed, out to the customer, waiting on an exact report, or new. */
export function requestStatus(status: ProposalStatus, basis: MeasurementKind): RequestStatus {
  if (status === 'signed') return 'signed';
  if (status === 'sent' || status === 'viewed') return 'estimate_sent';
  return basis === 'exact' ? 'inspection' : 'new_lead';
}

export function toRow(p: ProposalView): RequestRow {
  const option = p.options[0];
  const squares = option ? option.calculation.roofSquares : null;
  return {
    measurementId: p.measurementId,
    proposalId: p.id,
    number: p.number,
    name: p.customer.name,
    address: p.address,
    material: option ? measure.materials[option.scope.material] : null,
    squares: squares !== null && Number.isFinite(squares) ? squares : null,
    status: requestStatus(p.status, p.basis),
  };
}

/** The requests for a search term, one row per measurement, with how many the server counts. */
export function useRequestRows(term: string) {
  const list = useProposalGroup(REQUEST_STATUSES, term);
  const seen = new Set<string>();
  const rows: RequestRow[] = [];
  for (const page of list.data?.pages ?? []) {
    for (const p of page.proposals) {
      if (seen.has(p.measurementId)) continue;
      seen.add(p.measurementId);
      rows.push(toRow(p));
    }
  }
  const lastTotals = list.data?.pages.at(-1)?.totals ?? {};
  const total = Object.values(lastTotals).reduce((sum, n) => sum + n, 0);
  return { list, rows, total };
}

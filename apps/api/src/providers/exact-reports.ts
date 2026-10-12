export type ExactPrice = { minCents: number; maxCents: number; expiresAt: Date };
export type ExactReport = {
  surfaceSqFt: number;
  pitchX12: number;
  ridgeFt: number;
  edgeFt: number;
  valleyFt: number;
  facets: number | null;
  reportRef: string;
};
export type ExactAddress = { street: string; city: string; state: string; zip: string };
export type ExactOrderInput = { address: ExactAddress; productId: number; referenceId: string };
export interface ExactReports {
  readonly configured: boolean;
  price(i: ExactOrderInput): Promise<ExactPrice>;
  /** May throw ExactOrderUncertainError. */
  order(i: ExactOrderInput): Promise<{ reportId: string }>;
  report(
    reportId: string,
  ): Promise<
    | { status: 'pending' }
    | { status: 'complete'; report: ExactReport; costCents: number | null }   // null: the report carried no readable cost (the caller falls back to the quoted max)
    | { status: 'failed'; reasonKey: string }
  >;
}
export class ExactReportsUnavailableError extends Error {}
export class ExactOrderUncertainError extends Error {}

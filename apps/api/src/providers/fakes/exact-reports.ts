import {
  ExactOrderUncertainError,
  type ExactOrderInput,
  type ExactPrice,
  type ExactReport,
  type ExactReports,
} from '../exact-reports.ts';

export type ExactCall = { method: 'price' | 'order' | 'report'; args: { input?: ExactOrderInput; reportId?: string } };

export class FakeExactReports implements ExactReports {
  readonly configured = true;
  readonly calls: ExactCall[] = [];
  private failures = 0;
  private n = 0;
  private uncertain = false;
  private readonly completed = new Set<string>();
  constructor(private readonly now: () => Date = () => new Date()) {}
  failNext(n = 1): void {
    this.failures = n;
  }
  orderUncertainNext(): void {
    this.uncertain = true;
  }
  complete(reportId: string): void {
    this.completed.add(reportId);
  }
  private record(call: ExactCall): void {
    this.calls.push(call);
    if (this.failures > 0) {
      this.failures--;
      throw new Error('Fake exact reports failure');
    }
  }
  async price(i: ExactOrderInput): Promise<ExactPrice> {
    this.record({ method: 'price', args: { input: i } });
    return { minCents: 4200, maxCents: 6200, expiresAt: new Date(this.now().getTime() + 10 * 60_000) };
  }
  async order(i: ExactOrderInput): Promise<{ reportId: string }> {
    this.record({ method: 'order', args: { input: i } });
    const reportId = `rep-${++this.n}`;
    if (this.uncertain) {
      this.uncertain = false;
      throw new ExactOrderUncertainError('The order result is unknown.');
    }
    return { reportId };
  }
  async report(
    id: string,
  ): Promise<
    | { status: 'pending' }
    | { status: 'complete'; report: ExactReport; costCents: number }
    | { status: 'failed'; reasonKey: string }
  > {
    this.record({ method: 'report', args: { reportId: id } });
    if (!this.completed.has(id)) return { status: 'pending' };
    return {
      status: 'complete',
      report: { surfaceSqFt: 2612, pitchX12: 7, ridgeFt: 62, edgeFt: 188, eaveFt: 142, valleyFt: 24, facets: 9, reportRef: id },
      costCents: 4500,
    };
  }
}

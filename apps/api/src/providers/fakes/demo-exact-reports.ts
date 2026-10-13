import { randomUUID } from 'node:crypto';
import type { ExactOrderInput, ExactReport } from '../exact-reports.ts';
import { FakeExactReports } from './exact-reports.ts';

/** How long a demo exact report takes to come back after it is ordered. */
export const DEMO_EXACT_REPORT_MS = 20_000;

const PREFIX = 'demo-rep-';

/**
 * The demo's exact roof reports (DEMO_MODE): priced and ordered like the fake, but every report completes on its own
 * about 20 seconds after the order, so "Get exact report" goes from approval to a finished report live on stage.
 * The order time is in the report id, so it survives a worker restart; ids never repeat. No network, no charge.
 */
export class DemoExactReports extends FakeExactReports {
  constructor(private readonly clock: () => Date = () => new Date()) {
    super(clock);
  }

  override async order(i: ExactOrderInput): Promise<{ reportId: string }> {
    this.calls.push({ method: 'order', args: { input: i } });
    return { reportId: `${PREFIX}${this.clock().getTime()}-${randomUUID().slice(0, 8)}` };
  }

  override async report(
    id: string,
  ): Promise<
    | { status: 'pending' }
    | { status: 'complete'; report: ExactReport; costCents: number }
    | { status: 'failed'; reasonKey: string }
  > {
    const orderedAt = id.startsWith(PREFIX) ? Number(id.slice(PREFIX.length).split('-')[0]) : Number.NaN;
    if (Number.isFinite(orderedAt) && this.clock().getTime() - orderedAt >= DEMO_EXACT_REPORT_MS) this.complete(id);
    return super.report(id);
  }
}

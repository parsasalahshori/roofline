import { type AerialMeasure, type AerialRoof, AerialUnavailableError } from '../aerial.ts';

export type AerialCall = { method: 'start' | 'result'; args: { address?: string; requestId?: string } };

export class FakeAerialMeasure implements AerialMeasure {
  readonly configured = true;
  readonly calls: AerialCall[] = [];
  private failures = 0;
  private n = 0;
  private readonly seen = new Map<string, boolean>();
  failNext(n = 1): void {
    this.failures = n;
  }
  private record(call: AerialCall): void {
    this.calls.push(call);
    if (this.failures > 0) {
      this.failures--;
      throw new Error('Fake aerial failure');
    }
  }
  async start(address: string): Promise<{ requestId: string }> {
    this.record({ method: 'start', args: { address } });
    if (/outage/i.test(address)) throw new AerialUnavailableError("Aerial measurement isn't available.");
    const requestId = `req-${++this.n}`;
    this.seen.set(requestId, false);
    return { requestId };
  }
  async result(id: string): Promise<{ status: 'pending' } | { status: 'complete'; roofs: AerialRoof[] }> {
    this.record({ method: 'result', args: { requestId: id } });
    const seen = this.seen.get(id);
    if (seen === undefined) throw new Error(`Unknown aerial request ${id}`);
    if (!seen) {
      this.seen.set(id, true);
      return { status: 'pending' };
    }
    return { status: 'complete', roofs: [{ areaSqFt: 2480, pitchX12: 7, structureIndex: 0 }] };
  }
}

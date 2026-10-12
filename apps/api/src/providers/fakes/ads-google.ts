import { type AdCreate, type AdErrorKind, AdPlatformError, type AdStats, type AdsGoogle } from '../ads-google.ts';

/** Deterministic Google Ads: no network. Links, campaigns and spend live in memory. */
export class FakeAdsGoogle implements AdsGoogle {
  readonly configured = true;
  managerId = '123-456-7890';
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly campaigns = new Map<string, { input: AdCreate; status: 'active' | 'paused'; spendCents: number }>();
  private readonly links = new Map<string, 'pending' | 'active' | 'refused'>();
  private readonly failures: AdErrorKind[] = [];
  private nextId = 1;
  private loseNextStatus: AdErrorKind | null = null;

  /** Makes the next interface call throw AdPlatformError(kind); calls queue in order. */
  failNext(kind: AdErrorKind): void {
    this.failures.push(kind);
  }
  accept(customerId: string): void {
    this.links.set(customerId, 'active');
  }
  refuse(customerId: string): void {
    this.links.set(customerId, 'refused');
  }
  /** The next setStatus applies on the platform and then throws AdPlatformError(kind): a lost response. */
  loseResponseOnNextSetStatus(kind: AdErrorKind = 'other'): void {
    this.loseNextStatus = kind;
  }
  setSpend(campaignId: string, cents: number): void {
    const c = this.campaigns.get(campaignId);
    if (!c) throw new AdPlatformError('other');
    c.spendCents = cents;
  }

  private enter(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    const kind = this.failures.shift();
    if (kind !== undefined) throw new AdPlatformError(kind);
  }

  async invite(customerId: string): Promise<void> {
    this.enter('invite', [customerId]);
    if (this.links.get(customerId) !== 'active') this.links.set(customerId, 'pending');
  }
  async unlink(customerId: string): Promise<void> {
    this.enter('unlink', [customerId]);
    this.links.delete(customerId);
  }
  async linkStatus(customerId: string): Promise<'pending' | 'active' | 'refused' | 'none'> {
    this.enter('linkStatus', [customerId]);
    return this.links.get(customerId) ?? 'none';
  }
  async accountInfo(customerId: string): Promise<{ name: string; currency: string }> {
    this.enter('accountInfo', [customerId]);
    return { name: `Fake Ads ${customerId}`, currency: 'USD' };
  }
  async findCampaign(customerId: string, nameTag: string): Promise<string | null> {
    this.enter('findCampaign', [customerId, nameTag]);
    for (const [id, c] of this.campaigns) {
      if (c.input.accountId === customerId && c.input.nameTag === nameTag) return id;
    }
    return null;
  }
  async createCampaign(c: AdCreate): Promise<{ campaignId: string }> {
    this.enter('createCampaign', [c]);
    const campaignId = `g-${this.nextId++}`;
    this.campaigns.set(campaignId, { input: c, status: 'paused', spendCents: 0 });
    return { campaignId };
  }
  async setStatus(customerId: string, campaignId: string, s: 'active' | 'paused'): Promise<void> {
    this.enter('setStatus', [customerId, campaignId, s]);
    const c = this.campaigns.get(campaignId);
    if (!c) throw new AdPlatformError('other');
    c.status = s;
    if (this.loseNextStatus !== null) {
      const kind = this.loseNextStatus;
      this.loseNextStatus = null;
      throw new AdPlatformError(kind);
    }
  }
  async stats(customerId: string, campaignId: string): Promise<AdStats> {
    this.enter('stats', [customerId, campaignId]);
    const c = this.campaigns.get(campaignId);
    if (!c) throw new AdPlatformError('other');
    return { spendCents: c.spendCents, impressions: c.spendCents * 10, clicks: Math.floor(c.spendCents / 50), status: c.status };
  }
}

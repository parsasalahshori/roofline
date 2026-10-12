import { type AdErrorKind, AdPlatformError, type AdStats } from '../ads-google.ts';
import type { AdsMeta, MetaCreate } from '../ads-meta.ts';

/** Deterministic Meta Ads: no network. */
export class FakeAdsMeta implements AdsMeta {
  readonly configured = true;
  businessId = '1234567890';
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly campaigns = new Map<string, { input: MetaCreate; status: 'active' | 'paused'; spendCents: number }>();
  private readonly access = new Map<string, 'shared' | 'not_assigned' | 'disabled'>();
  private readonly failures: AdErrorKind[] = [];
  private housingRequired = false;
  private nextId = 1;
  private loseNextStatus: AdErrorKind | null = null;

  failNext(kind: AdErrorKind): void {
    this.failures.push(kind);
  }
  share(adAccountId: string): void {
    this.access.set(adAccountId, 'shared');
  }
  unassign(adAccountId: string): void {
    this.access.set(adAccountId, 'not_assigned');
  }
  disable(adAccountId: string): void {
    this.access.set(adAccountId, 'disabled');
  }
  /** The next createCampaign with housing false throws 'targeting'; a housing true call clears the flag. */
  requireHousingNext(): void {
    this.housingRequired = true;
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

  async verifyAccess(
    adAccountId: string,
  ): Promise<{ ok: true; name: string; currency: string } | { ok: false; reason: 'not_shared' | 'not_assigned' | 'disabled' }> {
    this.enter('verifyAccess', [adAccountId]);
    const state = this.access.get(adAccountId);
    if (state === 'shared') return { ok: true, name: `Fake Meta ${adAccountId}`, currency: 'USD' };
    if (state === 'not_assigned' || state === 'disabled') return { ok: false, reason: state };
    return { ok: false, reason: 'not_shared' };
  }
  async findCampaign(adAccountId: string, nameTag: string): Promise<string | null> {
    this.enter('findCampaign', [adAccountId, nameTag]);
    for (const [id, c] of this.campaigns) {
      if (c.input.accountId === adAccountId && c.input.nameTag === nameTag) return id;
    }
    return null;
  }
  async createCampaign(c: MetaCreate): Promise<{ campaignId: string }> {
    this.enter('createCampaign', [c]);
    if (this.housingRequired) {
      this.housingRequired = false;
      if (!c.housing) throw new AdPlatformError('targeting');
    }
    const campaignId = `m-${this.nextId++}`;
    this.campaigns.set(campaignId, { input: c, status: 'paused', spendCents: 0 });
    return { campaignId };
  }
  async setStatus(adAccountId: string, campaignId: string, s: 'active' | 'paused'): Promise<void> {
    this.enter('setStatus', [adAccountId, campaignId, s]);
    const c = this.campaigns.get(campaignId);
    if (!c) throw new AdPlatformError('other');
    c.status = s;
    if (this.loseNextStatus !== null) {
      const kind = this.loseNextStatus;
      this.loseNextStatus = null;
      throw new AdPlatformError(kind);
    }
  }
  async stats(adAccountId: string, campaignId: string): Promise<AdStats> {
    this.enter('stats', [adAccountId, campaignId]);
    const c = this.campaigns.get(campaignId);
    if (!c) throw new AdPlatformError('other');
    return { spendCents: c.spendCents, impressions: c.spendCents * 10, clicks: Math.floor(c.spendCents / 50), status: c.status };
  }
}

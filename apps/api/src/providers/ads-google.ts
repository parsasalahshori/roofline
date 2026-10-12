export type AdErrorKind = 'policy' | 'payment' | 'access' | 'targeting' | 'other';
export type Circle = { lat: number; lng: number; radiusM: number };
export type AdCreate = { accountId: string; nameTag: string; dailyBudgetCents: number; startDate: string; endDate: string; circles: Circle[];
  landingUrl: string; headline: string; description: string; companyName: string; city: string; keywords: string[] };
export type AdStats = { spendCents: number; impressions: number; clicks: number; status: 'paused' | 'active' | 'ended' | 'removed' };
export class AdPlatformError extends Error {
  constructor(readonly kind: AdErrorKind, readonly status?: number) {
    super(`Ad platform error: ${kind}`);
    this.name = 'AdPlatformError';
  }
}
export interface AdsGoogle { readonly configured: boolean; managerId: string;
  invite(customerId: string): Promise<void>; linkStatus(customerId: string): Promise<'pending' | 'active' | 'refused' | 'none'>;
  accountInfo(customerId: string): Promise<{ name: string; currency: string }>;
  findCampaign(customerId: string, nameTag: string): Promise<string | null>;
  createCampaign(c: AdCreate): Promise<{ campaignId: string }>;        // created PAUSED
  setStatus(customerId: string, campaignId: string, s: 'active' | 'paused'): Promise<void>;
  stats(customerId: string, campaignId: string): Promise<AdStats> }

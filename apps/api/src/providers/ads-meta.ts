import type { AdCreate, AdStats } from './ads-google.ts';

export type MetaCreate = Omit<AdCreate, 'keywords'> & { primaryText: string; imagePng: Uint8Array; housing: boolean };
export interface AdsMeta { readonly configured: boolean; businessId: string;
  verifyAccess(adAccountId: string): Promise<{ ok: true; name: string; currency: string } | { ok: false; reason: 'not_shared' | 'not_assigned' | 'disabled' }>;
  findCampaign(adAccountId: string, nameTag: string): Promise<string | null>;
  createCampaign(c: MetaCreate): Promise<{ campaignId: string }>;      // created PAUSED; throws AdPlatformError('targeting') when Meta requires Housing
  setStatus(adAccountId: string, campaignId: string, s: 'active' | 'paused'): Promise<void>;
  stats(adAccountId: string, campaignId: string): Promise<AdStats> }

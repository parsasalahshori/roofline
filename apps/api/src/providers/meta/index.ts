import type { Config } from '../../config.ts';
import { AdPlatformError } from '../ads-google.ts';
import type { AdsMeta } from '../ads-meta.ts';
import { createCampaign, findCampaign, setStatus } from './campaigns.ts';
import { createMetaHttp, type MetaHttp } from './http.ts';
import { verifyAccess } from './link.ts';
import { metaStats } from './report.ts';

/**
 * The real Meta adapter, or null when any META_* setting is missing. `fetchImpl` exists so that
 * tests can inject a fake network; production passes nothing and gets the global fetch.
 */
export function metaAdsFor(config: Config, fetchImpl?: typeof fetch): AdsMeta | null {
  const { META_APP_ID, META_APP_SECRET, META_SYSTEM_USER_TOKEN, META_BUSINESS_ID } = config;
  if (!META_APP_ID || !META_APP_SECRET || !META_SYSTEM_USER_TOKEN || !META_BUSINESS_ID) return null;

  const http: MetaHttp = createMetaHttp({
    appSecret: META_APP_SECRET,
    token: META_SYSTEM_USER_TOKEN,
    version: config.META_GRAPH_VERSION,
    fetch: fetchImpl,
  });

  // The system user id is read once from `me`. A failed read is not cached, so the next call retries.
  let systemUser: Promise<string> | undefined;
  const systemUserId = (): Promise<string> => {
    systemUser ??= (async () => {
      const me = (await http.get('me', { fields: 'id' })) as { id?: unknown } | null;
      if (typeof me?.id !== 'string' || me.id === '') throw new AdPlatformError('access');
      return me.id;
    })().catch((err: unknown) => {
      systemUser = undefined;
      throw err;
    });
    return systemUser;
  };

  return {
    configured: true,
    businessId: META_BUSINESS_ID,
    verifyAccess: async (adAccountId) => verifyAccess(http, adAccountId, await systemUserId()),
    findCampaign: (adAccountId, nameTag) => findCampaign(http, adAccountId, nameTag),
    createCampaign: (c) => createCampaign(http, c),
    setStatus: (adAccountId, campaignId, s) => setStatus(http, adAccountId, campaignId, s),
    stats: (adAccountId, campaignId) => metaStats(http, adAccountId, campaignId),
  };
}

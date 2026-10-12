import type { Config } from '../../config.ts';
import type { AdsGoogle } from '../ads-google.ts';
import { createCampaigns } from './campaigns.ts';
import {
  type FetchLike,
  type GoogleAdsSettings,
  createGoogleAdsHttp,
} from './http.ts';
import { createLink } from './link.ts';
import { createReport } from './report.ts';

/** The real Google Ads adapter when configured; null when any of the five GOOGLE_ADS settings is unset. */
export function googleAdsFor(
  config: Config,
  fetchImpl: FetchLike = globalThis.fetch,
): AdsGoogle | null {
  const {
    GOOGLE_ADS_DEVELOPER_TOKEN,
    GOOGLE_ADS_MANAGER_ID,
    GOOGLE_ADS_CLIENT_ID,
    GOOGLE_ADS_CLIENT_SECRET,
    GOOGLE_ADS_REFRESH_TOKEN,
  } = config;
  if (
    !GOOGLE_ADS_DEVELOPER_TOKEN ||
    !GOOGLE_ADS_MANAGER_ID ||
    !GOOGLE_ADS_CLIENT_ID ||
    !GOOGLE_ADS_CLIENT_SECRET ||
    !GOOGLE_ADS_REFRESH_TOKEN
  ) {
    return null;
  }

  const settings: GoogleAdsSettings = {
    developerToken: GOOGLE_ADS_DEVELOPER_TOKEN,
    managerId: GOOGLE_ADS_MANAGER_ID,
    clientId: GOOGLE_ADS_CLIENT_ID,
    clientSecret: GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: GOOGLE_ADS_REFRESH_TOKEN,
    apiVersion: config.GOOGLE_ADS_API_VERSION,
  };
  const http = createGoogleAdsHttp(settings, fetchImpl);
  const managerId = GOOGLE_ADS_MANAGER_ID.replace(/-/g, '');
  const link = createLink(http, managerId);
  const report = createReport(http);
  const campaigns = createCampaigns(http);

  return {
    configured: true,
    managerId,
    invite: (customerId) => link.invite(customerId),
    unlink: (customerId) => link.unlink(customerId),
    linkStatus: (customerId) => link.linkStatus(customerId),
    accountInfo: (customerId) => link.accountInfo(customerId),
    findCampaign: (customerId, nameTag) =>
      campaigns.findCampaign(customerId, nameTag),
    createCampaign: (c) => campaigns.createCampaign(c),
    setStatus: (customerId, campaignId, s) =>
      campaigns.setStatus(customerId, campaignId, s),
    stats: (customerId, campaignId) => report.stats(customerId, campaignId),
  };
}

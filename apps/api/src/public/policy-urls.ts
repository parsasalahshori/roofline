import type { Config } from '../config.ts';

/**
 * The public privacy and terms page addresses for a policy slug: on the company's own host when
 * POLICY_PAGES_DOMAIN is set, otherwise under the app's public base URL.
 */
export function policyUrls(
  config: Pick<Config, 'POLICY_PAGES_DOMAIN' | 'PUBLIC_BASE_URL'>,
  slug: string,
): { privacy: string; terms: string } {
  if (config.POLICY_PAGES_DOMAIN) {
    const origin = `https://${slug}.${config.POLICY_PAGES_DOMAIN}`;
    return { privacy: `${origin}/privacy`, terms: `${origin}/terms` };
  }
  const base = `${config.PUBLIC_BASE_URL}/policies/${slug}`;
  return { privacy: `${base}/privacy`, terms: `${base}/terms` };
}

import type { Config } from '../config.ts';

/** The public privacy and terms page addresses for a policy slug, under the app's public base URL. */
export function policyUrls(config: Config, slug: string): { privacy: string; terms: string } {
  return {
    privacy: `${config.PUBLIC_BASE_URL}/policies/${slug}/privacy`,
    terms: `${config.PUBLIC_BASE_URL}/policies/${slug}/terms`,
  };
}

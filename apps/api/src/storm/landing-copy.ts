/** Text shared by the storm landing page (public/storm-page.ts) and the request handler (storm/landing.ts). */

/** The exact consent sentence next to the unchecked box. It is stored with the request and as consent evidence. */
export const STORM_CONSENT_TEXT =
  'Yes, text me about my inspection request and this storm. Message and data rates may apply. Reply STOP to stop. Consent is not required to ask for an inspection.';

/** Form field names, shared by the HTML form and the zod schema. */
export const STORM_FORM_FIELDS = { name: 'name', phone: 'phone', address: 'address', okToText: 'okToText', website: 'website' } as const;

/**
 * Limits for POST /api/public/storm-requests/:code (Ruling BF).
 * - perIpPerHour: one IP, across all pages.
 * - perPagePerHour: all IPs on one page.
 * - perIpPerPagePerHour: one IP's share of one page, so it takes at least 25 IPs to fill a page's 50.
 * - perPhonePerPage: one request per phone per page, ever (the page's unique key; stricter than per day).
 *   A repeat is accepted silently (the same thank-you page), with no new customer or job.
 * Per-IP limits only mean something when TRUST_PROXY matches the real proxy hop count (F2/F3 finding 4).
 */
export const STORM_REQUEST_LIMITS = { perIpPerHour: 5, perPagePerHour: 50, perIpPerPagePerHour: 2, perPhonePerPage: 1 } as const;

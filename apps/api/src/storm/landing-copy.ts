/** Text shared by the storm landing page (public/storm-page.ts) and the request handler (storm/landing.ts). */

/** The exact consent sentence next to the unchecked box. It is stored with the request and as consent evidence. */
export const STORM_CONSENT_TEXT =
  'Yes, text me about my inspection request and this storm. Message and data rates may apply. Reply STOP to stop. Consent is not required to ask for an inspection.';

/** Form field names, shared by the HTML form and the zod schema. */
export const STORM_FORM_FIELDS = { name: 'name', phone: 'phone', address: 'address', okToText: 'okToText', website: 'website' } as const;

/** Per-IP and per-page limits for POST /api/public/storm-requests/:code. */
export const STORM_REQUEST_LIMITS = { perIpPerHour: 5, perPagePerHour: 50 } as const;

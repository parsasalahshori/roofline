/** The page where a homeowner measures their windows in the phone's browser (Android, and what the desktop QR code opens). */
export const measurePath = (slug: string): string => `/q/${slug}/measure`;

/** The same page for one estimate: `request` is the quote's id. */
export const measureLink = (slug: string, requestId: string): string => `${measurePath(slug)}?request=${encodeURIComponent(requestId)}`;

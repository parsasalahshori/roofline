import type { Scope } from '@roofline/shared';

/** What the editor changes: the whole scope plus the quote notes as text (empty string means none). */
export type QuoteDraft = { scope: Scope; notes: string };

/**
 * The PATCH /api/quotes/:id body. A scope replaces the whole scope, so it is always complete;
 * `measurement` repeats area, areaType and pitch from the scope; `notes` is null when empty.
 */
export type SaveQuoteBody = {
  measurement: { source: 'manual'; areaSqFt: number; areaType: Scope['areaType']; pitch: number; notes: string | null };
  scope: Scope;
  notes: string | null;
};

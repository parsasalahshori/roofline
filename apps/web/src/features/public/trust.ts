import { publicCopy } from '../../copy/public.ts';

/**
 * What a company can say about itself on its homeowner pages, entered or connected in its own settings (REDESIGN 7.2).
 * Every part is optional, and a part that is not complete or not believable is left out: the page never shows a rating
 * without its source and its count, and never a number the company did not provide.
 */
export type TrustFacts = {
  /** From the connected business profile: the average, how many reviews it is over, and whose reviews they are ("Google"). */
  rating?: { value: number; count: number; source: string; /** Shown as "2,400+". */ plus?: boolean } | null;
  /** The year the company started. */
  sinceYear?: number | null;
  /** The licence the owner entered: the state and the number. */
  license?: { state: string; number: string } | null;
  /** Up to three short badges ("A+ BBB", "Made in USA"). */
  badges?: readonly string[];
};

export type TrustItem = { key: 'rating' | 'since' | 'license'; value: string; caption: string };

/** The facts that can be shown, in the order the row reads: rating, years, licence. */
export function trustItems(facts: TrustFacts | null | undefined, now: Date = new Date()): TrustItem[] {
  const items: TrustItem[] = [];
  const rating = facts?.rating;
  const source = rating?.source.trim() ?? '';
  if (rating && Number.isFinite(rating.value) && rating.value >= 1 && rating.value <= 5 && Number.isInteger(rating.count) && rating.count >= 1 && source !== '') {
    items.push({ key: 'rating', value: rating.value.toFixed(1), caption: publicCopy.ratingCaption(rating.count, source, rating.plus === true) });
  }
  const year = facts?.sinceYear;
  if (typeof year === 'number' && Number.isInteger(year) && year >= 1900 && year <= now.getFullYear()) {
    items.push({ key: 'since', value: String(year), caption: publicCopy.sinceCaption });
  }
  const license = facts?.license;
  const state = license?.state.trim().toUpperCase() ?? '';
  const number = license?.number.trim() ?? '';
  if (/^[A-Z]{2}$/.test(state) && number !== '' && number.length <= 24) {
    items.push({ key: 'license', value: `${state} #${number.replace(/^#/, '')}`, caption: publicCopy.licenseCaption });
  }
  return items;
}

/** The badges that can be shown: trimmed, not empty, at most three. */
export function trustBadges(facts: TrustFacts | null | undefined): string[] {
  return (facts?.badges ?? []).map((b) => b.trim()).filter((b) => b !== '').slice(0, 3);
}

/** The rating as one line ("4.9 from 2,400+ homeowners"), or null when it is not complete or not believable. */
export function ratingLine(facts: TrustFacts | null | undefined): string | null {
  const item = trustItems({ rating: facts?.rating ?? null }).find((i) => i.key === 'rating');
  return item === undefined ? null : publicCopy.ratingLine(Number(item.value), item.caption);
}

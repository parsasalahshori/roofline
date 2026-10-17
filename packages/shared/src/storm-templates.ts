// Task 4 package A: storm message templates, rendering, hail labels, plan title.

/** Default storm SMS. Marketing text: must keep "Reply STOP" and {company}. */
export const DEFAULT_STORM_SMS = 'Hi {first_name}, it\'s {company}. Radar shows hail up to {hail_size} hit near your home on {street} {day}. Want a free roof check this week? Reply YES to book. Reply STOP to opt out.';

/** Default storm email subject line. */
export const DEFAULT_STORM_EMAIL_SUBJECT = 'Hail near your home on {street}';

/** Default storm email body (plain text). Must keep {company}, {company_address} and {unsubscribe}. */
export const DEFAULT_STORM_EMAIL_BODY = [
  'Hi {first_name},',
  '',
  'Radar shows hail up to {hail_size} hit near your home on {street} {day}.',
  '',
  'Want a free roof check this week? Reply to this email to book.',
  '',
  '{company}',
  '{company_address}',
  'Unsubscribe: {unsubscribe}',
].join('\n');

/** Values used to fill a storm template. Optional fields are left as tokens when absent. */
export type StormFields = {
  first_name: string;
  company: string;
  hail_size: string;
  street: string;
  day: string;
  company_address?: string;
  unsubscribe?: string;
};

const STORM_TOKEN = /\{(first_name|company|hail_size|street|day|company_address|unsubscribe)\}/g;

/**
 * Fill a storm template in one pass. Replacement values are never re-scanned for tokens,
 * and `$` sequences in values are inserted literally. Unknown or missing tokens are left as
 * written, and decideEmail's content rule blocks any email that still holds them. Texts are
 * checked by Task 11/12's render hook, which must refuse a rendered body that still holds a
 * storm token. An empty or blank first_name becomes "there".
 */
export function renderStormTemplate(tpl: string, f: StormFields): string {
  const values: Record<string, string | undefined> = {
    first_name: f.first_name.trim() || 'there',
    company: f.company,
    hail_size: f.hail_size,
    street: f.street,
    day: f.day,
    company_address: f.company_address,
    unsubscribe: f.unsubscribe,
  };
  return tpl.replace(STORM_TOKEN, (match: string, key: string) => {
    const value = values[key];
    return value === undefined ? match : value;
  });
}

/**
 * List the compliance requirements a template is missing, in a fixed order.
 * SMS needs {company} and "Reply STOP" (case-insensitive). Email needs {company},
 * {company_address} and {unsubscribe} (literal, case-sensitive). Empty array when complete.
 */
export function missingStormTokens(tpl: string, channel: 'sms' | 'email'): string[] {
  const missing: string[] = [];
  if (channel === 'sms') {
    if (!tpl.includes('{company}')) missing.push('{company}');
    if (!tpl.toLowerCase().includes('reply stop')) missing.push('Reply STOP');
    return missing;
  }
  for (const token of ['{company}', '{company_address}', '{unsubscribe}']) {
    if (!tpl.includes(token)) missing.push(token);
  }
  return missing;
}

/** Format a hail size in inches with a trailing inch mark, e.g. 1.75 -> '1.75"', 1 -> '1"'. */
export function hailLabel(inches: number): string {
  return String(inches) + '"';
}

/**
 * A hail size as the owner reads it in a plan's title and summary: 1.75 -> '1.75 in'. A bare inch mark before a closing
 * bracket or a full stop ('(up to 1.5")') reads like a stray quote there; the customers' texts keep it (hailLabel).
 */
export function hailInches(inches: number): string {
  return `${inches} in`;
}

/**
 * Plan title for a storm. Uses the place name when present (non-blank),
 * otherwise a title without a place.
 */
export function stormTitle(placeName: string | null, maxIn: number): string {
  const label = hailInches(maxIn);
  if (placeName === null || placeName.trim() === '') {
    return `Storm plan for hail (up to ${label})`;
  }
  return `Storm plan for hail near ${placeName} (up to ${label})`;
}

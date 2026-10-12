import { emailCompanyFacts, stormConvectiveDay, type TenantContext, type Tx } from '@roofline/db';
import { stormDayLabel } from '@roofline/shared';

/*
 * Storm text rendering (S1 Task 11). Pure, no database. A storm text carries per-customer values for
 * {hail_size}, {street} and {day}; this fills them. {first_name} and {company} are filled later by the
 * gate request builder (gate-request.ts), so they are left exactly as written here.
 */

/** A storm token that is still in a body about to be texted. */
export const STORM_TOKEN_IN_TEXT = /\{(first_name|company|hail_size|street|day)\}/;

export const UNFILLED_TEXT_REASON = 'This text still has a blank in it, so we did not send it.';

const FILLED = /\{(hail_size|street|day)\}/g;

/**
 * Returns undefined without `fields`; otherwise a function giving one customer's template with their
 * {hail_size}, {street} and {day} filled in. One pass; values go in literally and are never re-scanned.
 */
export function stormTextRender(
  body: string,
  fields: Record<string, Record<string, string>> | undefined,
  day?: string,
): ((customerId: string) => string) | undefined {
  if (fields === undefined) return undefined;
  return (customerId) => {
    const mine = fields[customerId] ?? fields[customerId.toLowerCase()];
    if (!mine) return body;
    return body.replace(FILLED, (token, name: string) => {
      if (name === 'day' && day !== undefined) return day;
      const value = Object.hasOwn(mine, name) ? mine[name] : undefined;
      return value === undefined ? token : value;
    });
  };
}

const STORM_PREFIX = /^storm:([0-9a-f-]{36})$/i;

/** The company storm id a storm step's dedupePrefix (`storm:<companyStormId>`) names, or null. */
export function stormIdFromPrefix(dedupePrefix: string | undefined): string | null {
  return dedupePrefix === undefined ? null : (STORM_PREFIX.exec(dedupePrefix)?.[1] ?? null);
}

/** The day label ('today', 'yesterday', 'on Monday') for this storm as of `now` in the company's zone; null when the storm or company is missing. */
export async function stormSendDay(tx: Tx, ctx: TenantContext, companyStormId: string, now: Date): Promise<string | null> {
  const convective = await stormConvectiveDay(tx, ctx, companyStormId);
  if (convective === null) return null;
  const facts = await emailCompanyFacts(tx, ctx);
  if (!facts) return null;
  return stormDayLabel(convective, now, facts.timezone);
}

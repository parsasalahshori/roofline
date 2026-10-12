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
): ((customerId: string) => string) | undefined {
  if (fields === undefined) return undefined;
  return (customerId) => {
    const mine = fields[customerId] ?? fields[customerId.toLowerCase()];
    if (!mine) return body;
    return body.replace(FILLED, (token, name: string) => {
      const value = Object.hasOwn(mine, name) ? mine[name] : undefined;
      return value === undefined ? token : value;
    });
  };
}

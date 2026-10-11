/**
 * Fills a message template for one customer: `{first_name}` becomes their first name (or "there"
 * when they have none) and `{company}` becomes the company's name. Every occurrence is replaced.
 * Any other `{token}` is left exactly as written, and so is a token in a different case
 * (`{Company}`): the checks that decide whether a body may be sent (steps.ts, the send gate) look
 * for the same literal tokens, so what is checked is what is sent.
 *
 * It is a single pass over the template, so a replacement is never read again as a token (a first
 * name of `{company}` stays that text), and the replacements are inserted as they are (a `$&` in a
 * company name is not a replace pattern).
 */
export function renderBody(template: string, vars: { first_name?: string; company: string }): string {
  const firstName = (vars.first_name ?? '').trim();
  return template.replace(/\{(first_name|company)\}/g, (_match, token: string) =>
    token === 'company' ? vars.company : firstName === '' ? 'there' : firstName,
  );
}

import type { PolicyCompany } from '@roofline/db/system';
import { displayUsPhone } from '@roofline/shared';

// DRAFT: this text is a draft until the owner's lawyer reviews it (spec section 9).
// Do not treat these pages as final legal terms before that review.

export const POLICY_TEMPLATE_VERSION = 'draft-2026-10';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function present(value: string | null): value is string {
  return value !== null && value.trim() !== '';
}

/** "street, city, state zip", with the missing parts left out. Null when there is no address. */
function addressLine(c: PolicyCompany): string | null {
  const stateZip = [c.state, c.zip].filter(present).join(' ');
  const parts = [c.street, c.city, stateZip].filter(present);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Shared by both pages. Every value is escaped; lines for missing values are omitted. */
function contactHtml(c: PolicyCompany): string {
  const lines: string[] = [];
  const address = addressLine(c);
  if (address !== null) lines.push(`<p>Address: ${escapeHtml(address)}</p>`);
  if (present(c.phoneE164)) lines.push(`<p>Phone: ${escapeHtml(displayUsPhone(c.phoneE164))}</p>`);
  if (present(c.email)) {
    const email = escapeHtml(c.email);
    lines.push(`<p>Email: <a href="mailto:${email}">${email}</a></p>`);
  }
  if (present(c.website)) lines.push(`<p>Website: ${escapeHtml(c.website)}</p>`);
  return `<section>\n<h2>Contact</h2>\n${lines.join('\n')}\n</section>`;
}

/** The company as shown in the page text: legal name, with the trading name when they differ. */
function partiesHtml(c: PolicyCompany): { legal: string; name: string; who: string } {
  const name = escapeHtml(c.name);
  const legal = escapeHtml(present(c.legalName) ? c.legalName : c.name);
  const who = legal === name ? name : `${legal}, doing business as ${name}`;
  return { legal, name, who };
}

function documentHtml(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="policy-version" content="${POLICY_TEMPLATE_VERSION}">`,
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    'body { max-width: 40rem; margin: 0 auto; padding: 1rem; font-family: system-ui, sans-serif; line-height: 1.5; }',
    '</style>',
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n');
}

export function privacyPolicyHtml(c: PolicyCompany): string {
  const { legal, name, who } = partiesHtml(c);
  const body = `
<h1>Privacy Policy</h1>
<p>This policy explains how ${who} handles personal information, including information about customers who receive text messages from ${name}.</p>
<section>
<h2>What we collect</h2>
<p>We collect the contact details that customers and prospects give us, such as name, phone number, email address and service address, along with notes about the work we do for them.</p>
</section>
<section>
<h2>How we use it</h2>
<p>${legal} uses this information to respond to requests, provide estimates and roofing services, and communicate with customers about their projects.</p>
</section>
<section>
<h2>Text messaging</h2>
<p>We send text messages only to people who have agreed to receive them.</p>
<p>No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.</p>
<p>Text messaging originator opt-in data and consent will not be shared with any third parties.</p>
</section>
${contactHtml(c)}`;
  return documentHtml(`Privacy Policy - ${c.name}`, body);
}

export function termsHtml(c: PolicyCompany): string {
  const { legal, name, who } = partiesHtml(c);
  const body = `
<h1>Terms of Service</h1>
<p>These terms apply to the text messages that ${who} sends.</p>
<section>
<h2>Program description</h2>
<p>${name} sends service and project text messages to customers who have agreed to receive them. Message frequency varies.</p>
<p>Message and data rates may apply.</p>
<p>Carriers are not liable for delayed or undelivered messages.</p>
</section>
<section>
<h2>Opt-in</h2>
<p>Customers agree to receive text messages from ${legal} when they give their mobile number for that purpose.</p>
</section>
<section>
<h2>Opt-out</h2>
<p>Reply STOP to opt out at any time. After you opt out, you will receive no further texts from ${name} unless you opt in again.</p>
</section>
<section>
<h2>Help</h2>
<p>Reply HELP for help.</p>
</section>
${contactHtml(c)}`;
  return documentHtml(`Terms of Service - ${c.name}`, body);
}

export function notFoundHtml(): string {
  return documentHtml('Page not found', `
<h1>Page not found</h1>
<p>We couldn't find that page.</p>`);
}

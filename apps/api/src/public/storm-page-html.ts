import { displayUsPhone } from '@roofline/shared';
import { STORM_CONSENT_TEXT, STORM_FORM_FIELDS } from '../storm/landing-copy.ts';
import { escapeHtml, notFoundHtml } from './policy-text.ts';

/** What the storm landing page shows: one company, one storm code, and whether this is the thank-you state. */
export type StormPageInput = {
  companyName: string;
  phoneE164: string | null;
  code: string;
  thanks: boolean;
  /** A sentence to show above the form (a no-JS redirect's ?error=). Plain text; escaped here. Ignored on the thank-you page. */
  error?: string;
};

/** The storm line. Radar estimates only: no hail sizes, no owner names, no other homes. */
const STORM_LINE = 'Radar-estimated hail was reported near your area recently.';

/** Inline only: no external stylesheet, font or script. Colors are tokens, redefined for dark mode. */
const STYLE = [
  ':root { --bg: #f5f6f7; --fg: #1d2127; --muted: #4f5660; --card: #ffffff; --line: #8a919b; --accent: #1f4fa3; --accent-fg: #ffffff; --error: #b42318; }',
  '@media (prefers-color-scheme: dark) {',
  '  :root { --bg: #15181d; --fg: #eef0f3; --muted: #bcc3cc; --card: #1f242b; --line: #8f98a4; --accent: #8fb6ff; --accent-fg: #0c1424; --error: #ff9a8f; }',
  '}',
  'html { -webkit-text-size-adjust: 100%; }',
  'body { margin: 0; background: var(--bg); color: var(--fg); font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 1rem; line-height: 1.5; }',
  'main { max-width: 32rem; margin: 0 auto; padding: 1rem; }',
  '.eyebrow { margin: 0.5rem 0 0; color: var(--muted); font-weight: 600; }',
  'h1 { font-size: 1.6rem; line-height: 1.2; margin: 0.4rem 0 0.75rem; }',
  'p { margin: 0 0 0.75rem; }',
  'a { color: var(--accent); }',
  '.tel { display: inline-flex; align-items: center; min-height: 44px; font-weight: 600; }',
  'form { margin-top: 1rem; }',
  '.field { margin: 0 0 1rem; }',
  '.field label { display: block; font-weight: 600; margin-bottom: 0.35rem; }',
  'input[type="text"], input[type="tel"] { display: block; width: 100%; box-sizing: border-box; min-height: 44px; padding: 0.6rem 0.75rem; font: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 6px; }',
  '.consent { display: flex; align-items: flex-start; gap: 0.6rem; margin: 0 0 1.25rem; }',
  '.consent input[type="checkbox"] { flex: 0 0 auto; width: 44px; height: 44px; margin: 0; accent-color: var(--accent); }',
  '.consent span { padding-top: 0.5rem; color: var(--muted); }',
  '.error { color: var(--error); font-weight: 600; }',
  'button { display: block; width: 100%; min-height: 44px; padding: 0.7rem 1rem; font: inherit; font-weight: 700; color: var(--accent-fg); background: var(--accent); border: 0; border-radius: 6px; cursor: pointer; }',
  'input:focus-visible, button:focus-visible, a:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }',
  // Visually hidden from people; a robot that fills every field still sends it.
  '.hp { position: absolute; left: -10000px; top: auto; width: 1px; height: 1px; overflow: hidden; }',
].join('\n');

function documentHtml(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex,nofollow">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    STYLE,
    '</style>',
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n');
}

/** The company's phone as a tel: link, or nothing when the company has no number. */
function phoneHtml(phoneE164: string | null): string {
  if (phoneE164 === null || phoneE164.trim() === '') return '';
  const tel = escapeHtml(phoneE164);
  return `<p>Questions? Call <a class="tel" href="tel:${tel}">${escapeHtml(displayUsPhone(phoneE164))}</a>.</p>`;
}

function requestFormHtml(code: string): string {
  const action = escapeHtml(`/api/public/storm-requests/${code}`);
  const f = STORM_FORM_FIELDS;
  return [
    `<form method="post" action="${action}" enctype="application/x-www-form-urlencoded">`,
    '<div class="field">',
    `<label for="${f.name}">Name</label>`,
    `<input type="text" id="${f.name}" name="${f.name}" autocomplete="name" required>`,
    '</div>',
    '<div class="field">',
    `<label for="${f.phone}">Mobile phone</label>`,
    `<input type="tel" id="${f.phone}" name="${f.phone}" autocomplete="tel" inputmode="tel" required>`,
    '</div>',
    '<div class="field">',
    `<label for="${f.address}">Address of the home to inspect</label>`,
    `<input type="text" id="${f.address}" name="${f.address}" autocomplete="street-address" required>`,
    '</div>',
    '<div class="hp" aria-hidden="true">',
    `<label>Website<input type="text" name="${f.website}" tabindex="-1" autocomplete="off"></label>`,
    '</div>',
    '<label class="consent">',
    `<input type="checkbox" name="${f.okToText}" value="on">`,
    `<span>${escapeHtml(STORM_CONSENT_TEXT)}</span>`,
    '</label>',
    '<button type="submit">Request a free inspection</button>',
    '</form>',
  ].join('\n');
}

/** The company's storm landing page (GET /storm/:code on its host). Server-rendered, no scripts, `noindex`. */
export function stormPageHtml(input: StormPageInput): string {
  const name = escapeHtml(input.companyName);
  const phone = phoneHtml(input.phoneE164);

  if (input.thanks) {
    const body = [
      '<main>',
      `<p class="eyebrow">${name}</p>`,
      '<h1>Thanks, we got your request</h1>',
      `<p>${name} will call you to set up your free inspection.</p>`,
      phone,
      '</main>',
    ].join('\n');
    return documentHtml(`Thanks - ${input.companyName}`, body);
  }

  const body = [
    '<main>',
    `<p class="eyebrow">${name}</p>`,
    '<h1>Get a free roof inspection</h1>',
    `<p>${STORM_LINE}</p>`,
    `<p>Tell us where to look and ${name} will call to set a time.</p>`,
    ...(input.error ? [`<p class="error" role="alert">${escapeHtml(input.error)}</p>`] : []),
    requestFormHtml(input.code),
    phone,
    '</main>',
  ].join('\n');
  return documentHtml(`Free roof inspection - ${input.companyName}`, body);
}

/** The page for a code that is unknown, inactive, or not this company's. It names no company. */
export function stormPageNotFoundHtml(): string {
  return notFoundHtml();
}

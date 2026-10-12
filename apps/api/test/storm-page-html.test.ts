import { describe, expect, test } from 'vitest';
import { stormPageHtml, stormPageNotFoundHtml } from '../src/public/storm-page-html.ts';
import { STORM_CONSENT_TEXT, STORM_FORM_FIELDS } from '../src/storm/landing-copy.ts';

const CODE = 'abcd2345';
const BASE = { companyName: 'Acme Roofing', phoneE164: '+14025550199', code: CODE, thanks: false };

describe('stormPageHtml (the landing page)', () => {
  test('is a full document with a noindex, nofollow robots meta', () => {
    const html = stormPageHtml(BASE);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
  });

  test('has no script, no external URL, and stays under 30 KB', () => {
    const html = stormPageHtml(BASE);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(30 * 1024);
  });

  test('the consent checkbox is present, not checked, and labelled with the exact consent text', () => {
    const html = stormPageHtml(BASE);
    const box = /<input[^>]*type="checkbox"[^>]*>/.exec(html);
    expect(box).not.toBeNull();
    expect(box![0]).toContain(`name="${STORM_FORM_FIELDS.okToText}"`);
    expect(box![0]).toContain('value="on"');
    expect(box![0]).not.toMatch(/\schecked\b/);
    const label = /<label class="consent"[\s\S]*?<\/label>/.exec(html);
    expect(label).not.toBeNull();
    expect(label![0]).toContain(STORM_CONSENT_TEXT);
  });

  test('has a visually hidden honeypot named website, out of the tab order and hidden from assistive tech', () => {
    const html = stormPageHtml(BASE);
    expect(html).toContain(`name="${STORM_FORM_FIELDS.website}"`);
    const input = /<input[^>]*name="website"[^>]*>/.exec(html);
    expect(input).not.toBeNull();
    expect(input![0]).toContain('tabindex="-1"');
    expect(input![0]).toContain('autocomplete="off"');
    const wrapper = /<div class="hp"[^>]*>/.exec(html);
    expect(wrapper).not.toBeNull();
    expect(wrapper![0]).toContain('aria-hidden="true"');
  });

  test('posts a plain form to an absolute path on the same host, with the three fields', () => {
    const html = stormPageHtml(BASE);
    expect(html).toContain(`<form method="post" action="/api/public/storm-requests/${CODE}"`);
    expect(html).toContain('enctype="application/x-www-form-urlencoded"');
    expect(html).toContain(`name="${STORM_FORM_FIELDS.name}"`);
    expect(html).toContain(`name="${STORM_FORM_FIELDS.phone}"`);
    expect(html).toContain(`name="${STORM_FORM_FIELDS.address}"`);
    expect(html).toContain('Request a free inspection');
  });

  test('shows the storm line exactly, with no hail numbers', () => {
    const html = stormPageHtml(BASE);
    expect(html).toContain('Radar-estimated hail was reported near your area recently.');
    expect(html).not.toMatch(/\d+(\.\d+)?\s*(in|inch)/i);
  });

  test('escapes the company name everywhere it appears', () => {
    const html = stormPageHtml({ ...BASE, companyName: 'Acme <b>Roofing</b>' });
    expect(html).toContain('Acme &lt;b&gt;Roofing&lt;/b&gt;');
    expect(html).not.toContain('<b>Roofing</b>');
  });

  test('shows the company phone as a tel: link, and no link when there is no phone', () => {
    const html = stormPageHtml(BASE);
    expect(html).toContain('href="tel:+14025550199"');
    expect(html).toContain('(402) 555-0199');

    const noPhone = stormPageHtml({ ...BASE, phoneE164: null });
    expect(noPhone).not.toContain('tel:');
  });

  test('the thank-you state has a heading and no form', () => {
    const html = stormPageHtml({ ...BASE, thanks: true });
    expect(html).not.toContain('<form');
    expect(html).toMatch(/<h1>[^<]+<\/h1>/);
    expect(html).toContain('Acme Roofing will call you');
  });
});

describe('stormPageHtml error alert', () => {
  test('shows a given error above the form, escaped, as a role="alert" line', () => {
    const html = stormPageHtml({ ...BASE, error: '<b>x</b>' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });

  test('has no alert when there is no error', () => {
    expect(stormPageHtml(BASE)).not.toContain('role="alert"');
  });

  test('ignores the error on the thank-you page', () => {
    const html = stormPageHtml({ ...BASE, thanks: true, error: '<b>x</b>' });
    expect(html).not.toContain('role="alert"');
  });

  test('error color is a theme token with a dark-mode value', () => {
    const html = stormPageHtml({ ...BASE, error: 'x' });
    expect(html).toContain('.error { color: var(--error); font-weight: 600; }');
    expect(html).toContain('--error: #b42318;');
    expect(html).toContain('--error: #ff9a8f;');
    expect(html.split('#b42318').length - 1).toBe(1);
  });
});

describe('stormPageNotFoundHtml', () => {
  test('is a not-found page that names no company', () => {
    const html = stormPageNotFoundHtml();
    expect(html).toContain("We couldn't find that page.");
    expect(html).not.toContain('Acme');
    expect(html).not.toContain('Bolt');
    expect(html).not.toContain('<form');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom applies no module CSS, so the rules that decide how the homeowner's pages look are read from the stylesheets.
const read = (path: string): string => readFileSync(resolve(import.meta.dirname, '../src', path), 'utf8');
const proposalPage = read('features/homeowner/HomeownerPage.module.css');
const signSheet = read('features/homeowner/SignFlow.module.css');
const signaturePad = read('features/homeowner/SignaturePad.module.css');
const quotePage = read('features/quote/QuotePage.module.css');
const header = read('features/public/PublicHeader.module.css');

/** The declarations of the first rule for a selector. */
function block(css: string, selector: string): string {
  const escaped = selector.replace(/[.[\]"=():*>+~]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
}

describe('selection on the homeowner pages is ink, not the company colour', () => {
  it('the quote page, the proposal page and the sign sheet (portaled to the body) tick a checkbox in ink', () => {
    for (const [name, css, selector] of [
      ['the quote page', quotePage, '.page'],
      ['the proposal page', proposalPage, '.page'],
      ['the sign sheet', signSheet, '.body'],
    ] as const) {
      const rule = block(css, selector);
      expect(rule, name).toContain('--checkbox-fill: var(--ink);');
      expect(rule, name).toContain('--checkbox-tick: var(--ink-inv);');
    }
  });
});

describe('the homeowner pages are made for a thumb', () => {
  it('the Call pill is 44px high', () => {
    expect(block(header, '.call')).toMatch(/height:\s*44px;/);
  });

  it('the main and second buttons on the quote and measure pages are 52px high', () => {
    expect(block(quotePage, '.page .primary[data-size]')).toMatch(/min-height:\s*52px;/);
    expect(block(quotePage, '.page .secondary[data-size]')).toMatch(/min-height:\s*52px;/);
  });
});

describe('what a person can pick or draw on has the control edge (3:1), not the hairline', () => {
  it('the Good, Better and Best tiles, the visit times, the service options, the empty box and the signature well', () => {
    expect(block(proposalPage, '.tile')).toContain('var(--line-ctl)');
    expect(block(quotePage, '.slot')).toContain('var(--line-ctl)');
    expect(block(quotePage, '.option')).toContain('var(--line-ctl)');
    expect(block(quotePage, '.rowBox[data-off]')).toContain('var(--line-ctl)');
    expect(block(signaturePad, '.well::after')).toContain('var(--line-ctl)');
  });
});

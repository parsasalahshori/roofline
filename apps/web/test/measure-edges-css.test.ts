import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom applies no module CSS, so the rules that keep the measure screens' edges clean (a card's padding, a pinned box, a
// fade, the room under a callout) are read from the stylesheets.
const read = (path: string): string => readFileSync(resolve(import.meta.dirname, '../src', path), 'utf8');
const order = read('features/measure/windows/order/OrderWindow.module.css');
const panel = read('features/measure/lift/ProposalPanel.module.css');
const scanBar = read('features/measure/lift/ScanBar.module.css');
const windows = read('features/measure/windows/WindowsWindow.module.css');

/** One declaration of the first rule for a selector in the text given (at any indent: a query's rules count). */
function valueOf(css: string, selector: string, property: string): string | undefined {
  const escaped = selector.replace(/[.[\]"=>()+*?^$|\\]/g, '\\$&');
  const block = new RegExp(`(?:^|\\n)[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`).exec(css)?.[1];
  return block === undefined ? undefined : new RegExp(`${property}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}

/** The text from a query's opening line on. */
const from = (css: string, query: string): string => css.slice(css.indexOf(query));

describe('the order sheet on a phone', () => {
  const phone = from(order, '@container orderSheet (max-width: 719.98px)');

  it('ends a line card’s status tag where the quantity and the sheet’s own padding end, 16px in', () => {
    expect(valueOf(phone, '.table .row > td.cStatus', 'padding-right')).toBe('16px');
  });

  it('centres the line count in the same 44px as the PO box beside it, so the two read on one line', () => {
    expect(valueOf(phone, '.poField input', 'min-height')).toBe('44px');
    expect(valueOf(phone, '.cell[data-cell="lines"] .cellValue', 'min-height')).toBe('44px');
    expect(valueOf(phone, '.cell[data-cell="lines"] .cellValue', 'align-items')).toBe('center');
  });
});

describe('the picked window’s panel beside the order sheet', () => {
  it('fades the bottom edge of the part that scrolls while there is more under it', () => {
    expect(valueOf(from(order, '@container orderSheet (min-width: 1040px)'), '.detailScroll[data-more="true"]', 'mask-image')).toContain('linear-gradient(to bottom');
  });
});

describe('the roof and windows proposal column', () => {
  it('fades the bottom edge of its scrolling part only while there is more under it, not always', () => {
    expect(valueOf(panel, '.scroll[data-more="true"]', 'mask-image')).toContain('linear-gradient(to bottom');
    // The old always-on fade over the footer cut a heading through its middle with nothing saying the column scrolls
    expect(panel).not.toContain('.foot::before');
  });
});

describe('the Measure roof callout', () => {
  it('stands clear of the credits strip along the bottom of a wide map, and keeps its lower place where they fold into a corner', () => {
    expect(valueOf(scanBar, '.bar', 'bottom')).toBe('30px');
    expect(valueOf(from(scanBar, '@container (max-width: 640px)'), '.bar', 'bottom')).toBe('20px');
  });
});

describe('the windows page on a phone', () => {
  it('gives the scan-again icon a thumb-wide target', () => {
    expect(valueOf(from(windows, '@media (max-width: 767.98px)'), '.replay[data-variant]', 'min-width')).toBe('44px');
  });
});

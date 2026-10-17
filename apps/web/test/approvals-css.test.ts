import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom applies no module CSS, so the rules that decide how the queue and the decision bar sit on the screen are read from the
// stylesheets.
const read = (path: string): string => readFileSync(resolve(import.meta.dirname, '../src', path), 'utf8');
const list = read('features/approvals/ApprovalsList.module.css');
const bar = read('features/approvals/ReviewBar.module.css');
const shell = read('shell/Shell.module.css');

/** One declaration of the first rule for a selector (at any indent: a media query's rules count). */
function valueOf(css: string, selector: string, property: string): string | undefined {
  const escaped = selector.replace(/[.[\]"=]/g, '\\$&');
  const block = new RegExp(`(?:^|\\n)[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`).exec(css)?.[1];
  return block === undefined ? undefined : new RegExp(`${property}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}

describe('the queue of plans', () => {
  it('gives the cards of a row the height of the tallest, so the gaps between rows are one gap', () => {
    expect(valueOf(list, '.grid', 'align-items')).toBe('stretch');
    expect(valueOf(list, '.grid', 'gap')).toBe('16px');
    // The list item is a column the card fills
    expect(valueOf(list, '.item', 'display')).toBe('flex');
    expect(valueOf(list, '.item', 'flex-direction')).toBe('column');
  });
});

describe('the decision bar of a plan on a phone', () => {
  it('is on a layer under the tab bar, so the Measure tile that stands up out of the tab bar is drawn over the bar', () => {
    const barLayer = Number(valueOf(bar, '.bar', 'z-index'));
    const tabLayer = Number(valueOf(shell, '.tabs', 'z-index'));
    expect(Number.isFinite(barLayer)).toBe(true);
    expect(Number.isFinite(tabLayer)).toBe(true);
    expect(barLayer).toBeLessThan(tabLayer);
  });
});

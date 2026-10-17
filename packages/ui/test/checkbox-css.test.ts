import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom applies no module CSS, so the rules that draw the box are read from the stylesheet.
const css = readFileSync(resolve(import.meta.dirname, '../src/components/Checkbox/Checkbox.module.css'), 'utf8');

describe('the drawn checkbox', () => {
  it('does not give a ticked box the hover edge: hovering it must not put a grey ring round the fill', () => {
    // The hover rule names :checked in its :not(), so it can never out-rank the ticked rule by specificity
    expect(css).toMatch(/\.input:hover:not\(:disabled,\s*:checked\)\s*\{/);
    expect(css).not.toMatch(/\.input:hover:not\(:disabled\)\s*\{/);
  });

  it('fills with the company colour unless the page sets its own fill and tick', () => {
    expect(css).toContain('background: var(--checkbox-fill, var(--brand));');
    expect(css).toContain('border-color: var(--checkbox-fill, var(--brand));');
    expect(css).toContain('background: var(--checkbox-tick, var(--brand-ink));');
  });

  it('has a row at least 44px tall on a phone, 40px elsewhere', () => {
    expect(css).toMatch(/\.row\s*\{[^}]*min-height:\s*40px;/);
    expect(css).toMatch(/@media \(max-width: 767\.98px\)\s*\{\s*\.row\s*\{\s*min-height:\s*44px;/);
  });
});

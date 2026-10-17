import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom does not apply module CSS, so the rules that decide how the card behaves in a narrow column are read from the
// stylesheet. Home holds the card in a column of 340 to 404px beside the map, on a page as wide as any desktop, so none of
// these rules may wait for a phone-sized window.
const css = readFileSync(resolve(import.meta.dirname, '../src/components/ApprovalCard/ApprovalCard.module.css'), 'utf8');

/** The declarations of the top-level rule for one selector, not the ones a media query repeats. */
function rule(selector: string): string {
  const topLevel = css.replace(/@media[^{]*\{[\s\S]*?\n\}/g, '');
  const match = new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(topLevel);
  return match?.[1] ?? '';
}

describe('the approval card in a narrow column', () => {
  it('lets the "drafted" line wrap at every width, so the age is never cut off', () => {
    const drafted = rule('.drafted');
    expect(drafted).toMatch(/min-width:\s*0/);
    expect(drafted).not.toMatch(/text-overflow/);
    expect(drafted).not.toMatch(/white-space:\s*nowrap/);
  });

  it('lets the facts and the buttons wrap instead of clipping', () => {
    expect(rule('.facts')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.actions')).toMatch(/flex-wrap:\s*wrap/);
  });
});

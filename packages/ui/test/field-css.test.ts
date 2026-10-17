import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom applies no module CSS, so the rules that decide how a text box looks are read from the stylesheet.
const css = readFileSync(resolve(import.meta.dirname, '../src/components/Field/Field.module.css'), 'utf8');

describe('the multiline Field', () => {
  it('resizes up and down on a desktop and not at all on a phone, where the grip in the corner is clutter', () => {
    expect(css).toMatch(/\ntextarea\.control\s*\{\s*resize:\s*vertical;/);
    expect(css).toMatch(/@media \(max-width: 767\.98px\)\s*\{\s*textarea\.control\s*\{\s*resize:\s*none;/);
  });
});

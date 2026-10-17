import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom does not apply module CSS, so the layout rules the review asked for are read from the stylesheets.
const read = (relative: string) => readFileSync(resolve(import.meta.dirname, '../src/features', relative), 'utf8');

describe('the customer page and the new customer form', () => {
  it('sets a contact label on the baseline of its value, whatever face the value is in', () => {
    const css = read('customers/CustomerWindow.module.css');
    const facts = /(?:^|\n)\.facts\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(facts).toMatch(/align-items:\s*baseline/);
    // A fixed top padding on the label was what pushed it below the value
    const label = /(?:^|\n)\.facts dt\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(label).not.toMatch(/padding-top/);
  });

  it('lets an address block put city, state and ZIP on one row when it is wide, and only then', () => {
    const css = read('create/Create.module.css');
    // The block measures itself, so a narrow sheet keeps two columns whatever the window
    expect(/(?:^|\n)\.address\s*\{([^}]*)\}/.exec(css)?.[1] ?? '').toMatch(/container-type:\s*inline-size/);
    const wide = /@container \(min-width: (\d+)px\)\s*\{\s*\.addressGrid\s*\{([^}]*)\}/.exec(css);
    expect(wide).not.toBeNull();
    expect(Number(wide?.[1])).toBeGreaterThanOrEqual(520);
    expect(wide?.[2]).toMatch(/grid-template-columns:[^;]*minmax\(0,[^;]*minmax\(0,[^;]*minmax\(0,/);
    // The base grid stays two columns
    const base = /(?:^|\n)\.addressGrid\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(base).toMatch(/repeat\(2,/);
  });
});

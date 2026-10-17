import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom applies no module CSS, so the rules that set a page title are read from the stylesheets.
const read = (path: string): string => readFileSync(resolve(import.meta.dirname, path), 'utf8');

/** The first `.title` rule's declaration for a property (at the top level of the file, outside a media query). */
function titleValue(css: string, property: string): string | undefined {
  const block = /(?:^|\n)\.title\s*\{([^}]*)\}/.exec(css)?.[1];
  return block === undefined ? undefined : new RegExp(`${property}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}

describe('the title of a page that draws its own head', () => {
  const page = read('../../../packages/ui/src/components/Page/Page.module.css');

  it('is read from the kit page title, so a test that compares nothing with nothing cannot pass', () => {
    expect(titleValue(page, 'font')).toMatch(/^750 \d+px\//);
    expect(titleValue(page, 'font-stretch')).toMatch(/^\d+%$/);
  });

  it.each([
    ['the new appointment and reschedule form', '../src/features/appointments/AppointmentForm.module.css'],
    ["an appointment's detail", '../src/features/appointments/AppointmentDetail.module.css'],
  ])('is the size and width of the kit page title: %s', (_name, path) => {
    const css = read(path);
    expect(titleValue(css, 'font')).toBe(titleValue(page, 'font'));
    expect(titleValue(css, 'font-stretch')).toBe(titleValue(page, 'font-stretch'));
  });
});

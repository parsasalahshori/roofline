import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom applies no module CSS, so the layers a phone screen is built from are read from the stylesheets.
const src = resolve(import.meta.dirname, '../src');
const shell = readFileSync(join(src, 'shell/Shell.module.css'), 'utf8');

/** Every .css file under a folder. */
function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return path.endsWith('.css') ? [path] : [];
  });
}

/** The z-index of the phone tab bar: the `.tabs` rule inside the shell's phone media query. */
function tabLayer(): number {
  const block = /(?:^|\n)[ \t]*\.tabs[ \t]*\{([^}]*)\}/.exec(shell.slice(shell.indexOf('@media (max-width: 767.98px)')))?.[1] ?? '';
  return Number(/z-index:\s*(\d+);/.exec(block)?.[1]);
}

/** Layers from here up are for what is meant to cover the whole screen: sheets and dialogs (40), toasts, menus, the full-screen takeovers. */
const OVERLAYS = 40;

describe('the phone tab bar layer', () => {
  it('is over every layer a page uses, so the raised Measure tile is never cut by a sticky bar sitting on the tab bar', () => {
    const tabs = tabLayer();
    expect(Number.isFinite(tabs)).toBe(true);
    const pages = cssFiles(join(src, 'features')).concat(cssFiles(join(src, 'shell')).filter((path) => !path.endsWith('Shell.module.css')));
    const over: string[] = [];
    for (const path of pages) {
      for (const match of readFileSync(path, 'utf8').matchAll(/z-index:\s*(\d+)\s*;/g)) {
        const layer = Number(match[1]);
        if (layer < OVERLAYS && layer >= tabs) over.push(`${path.slice(src.length + 1)} z-index ${layer}`);
      }
    }
    expect(over).toEqual([]);
  });

  it('is under the sheets, dialogs and full-screen takeovers', () => {
    expect(tabLayer()).toBeLessThan(OVERLAYS);
  });
});

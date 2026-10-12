// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every design token the Front Desk styles use must exist: an unknown var() silently draws nothing.

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const defined = (css: string) => new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const tokens = defined(readFileSync(here('../../../packages/ui/src/tokens.css'), 'utf8'));

function cssFiles(dir: string): string[] {
  return readdirSync(here(dir), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.module.css'))
    .map((name) => `${dir}/${name}`);
}

describe('Front Desk styles', () => {
  const files = [...cssFiles('../src/features/front-desk'), ...cssFiles('../src/features/timeline')];

  it.each(files)('%s uses only defined tokens', (file) => {
    const css = readFileSync(here(file), 'utf8');
    const local = defined(css);
    const unknown = [...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]).filter((name) => !tokens.has(name) && !local.has(name));
    expect(unknown).toEqual([]);
  });
});

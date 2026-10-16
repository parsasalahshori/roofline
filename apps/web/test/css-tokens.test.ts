// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// An unknown var() silently draws nothing, so every custom property a style reads must be defined: in the
// design tokens (packages/ui/src/tokens.css) or by a rule or a style prop in the code that reads it. The old
// S1, --ds-* and --lift-* names are gone for good: nothing may bring them back.

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(here(dir), { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.(css|tsx?)$/.test(name))
    .map((name) => `${dir}/${name}`);
}

const files = [...sourceFiles('../src'), ...sourceFiles('../../../packages/ui/src')].filter((file) => !file.includes('/vendor/'));
const text = new Map(files.map((file) => [file, readFileSync(here(file), 'utf8')]));

const defined = new Set<string>();
for (const source of text.values()) {
  for (const m of source.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]!);
  // A style prop: { '--row-h': ... } or { ['--x']: ... }
  for (const m of source.matchAll(/['"`](--[\w-]+)['"`]\s*:/g)) defined.add(m[1]!);
}

/** `var(--name` reads, minus a template's open end such as var(--hail-${level}). */
function reads(source: string): string[] {
  return [...source.matchAll(/var\((--[\w-]+)(?![\w-]*\$\{)/g)].map((m) => m[1]!);
}

describe('custom properties', () => {
  it('every var() reads a defined property', () => {
    const unknown: string[] = [];
    for (const [file, source] of text) {
      for (const name of new Set(reads(source))) {
        if (!defined.has(name)) unknown.push(`${file.replace('../', '')}: ${name}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('no style reads a legacy name', () => {
    const legacy: string[] = [];
    for (const [file, source] of text) {
      if (file.endsWith('tokens.css')) continue;
      for (const name of new Set(reads(source))) {
        if (/^--(ds|lift)-/.test(name) || ['--accent', '--accent-ink', '--text', '--text-muted', '--bg', '--danger', '--success', '--radius-card', '--radius-window', '--shadow-window', '--font'].includes(name)) {
          legacy.push(`${file.replace('../', '')}: ${name}`);
        }
      }
    }
    expect(legacy).toEqual([]);
  });
});

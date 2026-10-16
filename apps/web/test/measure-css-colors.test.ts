// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The Measure screens follow the theme: no colour is written into their CSS. The only literals are the few marks drawn on
 * a photograph, an aerial map or the camera (white scale bars, a dark letterbox, the gutter runs), which cannot follow
 * light and dark. They are allowed only as custom properties named --over-*, --gutter* or --paper, defined in one rule
 * under a comment that says they are literal on purpose; everything else uses var(--token).
 */
const FEATURES = fileURLToPath(new URL('../src/features/', import.meta.url));
const FOLDERS = ['measure', 'estimator'];
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|:\s*(?:white|black)\b/;
const ALLOWED_DEFINITION = /^\s*--(?:over|gutter|paper)[a-z0-9-]*\s*:/;

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

const files = FOLDERS.flatMap((folder) => cssFiles(join(FEATURES, folder)));

describe('Measure CSS has no hard-coded colours', () => {
  it('finds the stylesheets', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((f) => [f.slice(FEATURES.length), f]))('%s', (_name, path) => {
    const raw = readFileSync(path as string, 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
    const bad = code
      .split('\n')
      .map((text, i) => ({ text, line: i + 1 }))
      .filter(({ text }) => LITERAL.test(text) && !ALLOWED_DEFINITION.test(text));
    expect(bad.map((b) => `${b.line}: ${b.text.trim()}`)).toEqual([]);
    // A file that does hold literals says why, in a comment
    if (code.split('\n').some((text) => LITERAL.test(text))) expect(raw).toMatch(/literal/i);
  });
});

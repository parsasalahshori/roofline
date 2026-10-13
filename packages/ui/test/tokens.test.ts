// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tokens } from '../src/tokens.ts';

/** Every `--name: value;` declaration in tokens.css, keyed by the full `--name`. */
function readCssTokens(): Map<string, string> {
  const path = fileURLToPath(new URL('../src/tokens.css', import.meta.url));
  const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const root = /:root\s*{([^}]*)}/.exec(css);
  if (!root) throw new Error('tokens.css has no :root block');
  const found = new Map<string, string>();
  for (const m of root[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(m[1]!, m[2]!.trim());
  }
  return found;
}

// Neutral reference palette and geometry; existing map and hail semantics are preserved.
const EXPECTED: ReadonlyArray<readonly [string, string]> = [
  ['--bg', '#e9edf0'],
  ['--surface', '#f6f7f8'],
  ['--surface-2', '#e9edf0'],
  ['--text', '#151c22'],
  ['--accent', '#ffc400'],
  ['--accent-ink', '#151c22'],
  ['--success', '#2f9e44'],
  ['--danger', '#c9343d'],
  // The danger button's text and hover fill: white on --danger-hover stays above 4.5:1 (--danger itself is left alone).
  ['--on-danger', '#ffffff'],
  ['--danger-hover', '#c92a2a'],
  ['--line', '#d9dee2'],
  ['--radius-card', '20px'],
  ['--radius-window', '18px'],
  ['--shadow-window', '0 20px 40px -18px rgba(21, 28, 34, 0.45), 0 0 0 1px rgba(21, 28, 34, 0.08)'],
  // Opaque muted ink; contrast is covered by ironclad-full-ui.test.tsx.
  ['--text-muted', '#53616b'],
  ['--font', 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'],
  ['--font-size-min', '12px'],
  ['--font-size-body', '14px'],
  ['--font-size-stat', '24px'],
  ['--hail-1', '#ffe066'],
  ['--hail-2', '#ffb347'],
  ['--hail-3', '#ff7a45'],
  ['--hail-4', '#f0508c'],
  ['--hail-5', '#c026d3'],
  ['--pin-customer', '#7048e8'],
  ['--stage-lead', '#1971c2'],
  ['--stage-inspection', '#0b7285'],
  ['--stage-proposal', '#e67700'],
  ['--stage-won', '#2f9e44'],
];

describe('Ironclad tokens', () => {
  it('has every compatible token with its exact reference value', () => {
    const css = readCssTokens();
    for (const [name, value] of EXPECTED) {
      expect(css.get(name), name).toBe(value);
    }
  });

  it('tokens.ts mirrors tokens.css', () => {
    const css = readCssTokens();
    expect(Object.keys(tokens).length).toBe(css.size);
    for (const [key, value] of Object.entries(tokens)) {
      expect(css.get(`--${key}`), key).toBe(value);
    }
  });
});

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

// Spec 4.5 table, then the rulings and additions in the plan's Global Constraints.
const EXPECTED: ReadonlyArray<readonly [string, string]> = [
  ['--bg', '#efe9dc'],
  ['--surface', '#fffdf8'],
  ['--surface-2', '#f6f1e6'],
  ['--text', '#2b2620'],
  ['--accent', '#f5b324'],
  ['--accent-ink', '#2b2620'],
  ['--success', '#2f9e44'],
  ['--danger', '#e03131'],
  ['--line', '#eee5cf'],
  ['--radius-card', '12px'],
  ['--radius-window', '14px'],
  ['--shadow-window', '0 12px 30px rgba(60,40,0,.15)'],
  // 72%, not the spec's 60%: 60% is 4.0:1 on --surface, which fails the spec's own WCAG AA rule.
  ['--text-muted', 'rgba(43, 38, 32, 0.72)'],
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

describe('S1 tokens', () => {
  it('has every S1 token with its exact value', () => {
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

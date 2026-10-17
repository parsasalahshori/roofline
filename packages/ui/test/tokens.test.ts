// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio, mixRgb, parseColor, toHex, type Rgb } from '../src/brand.ts';
import { darkTokens, tokens, tokensFor } from '../src/tokens.ts';

const CSS = readFileSync(fileURLToPath(new URL('../src/tokens.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `--name: value;` declaration in a block of css, keyed by the full `--name`. */
function declarationsOf(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) found.set(m[1]!, m[2]!.trim());
  return found;
}

/** The first `:root { }` block: the light theme and the home of every token. */
function readLight(): Map<string, string> {
  const root = /:root\s*{([^}]*)}/.exec(CSS);
  if (!root) throw new Error('tokens.css has no :root block');
  return declarationsOf(root[1]!);
}

/** The dark theme twice: under the OS setting, and under data-theme="dark". */
function readDark(): { media: Map<string, string>; attribute: Map<string, string> } {
  const media = /@media \(prefers-color-scheme: dark\)\s*{\s*:root:not\(\[data-theme="light"\]\)\s*{([^}]*)}/.exec(CSS);
  const attribute = /:root\[data-theme="dark"\]\s*{([^}]*)}/.exec(CSS);
  if (!media || !attribute) throw new Error('tokens.css is missing a dark block');
  return { media: declarationsOf(media[1]!), attribute: declarationsOf(attribute[1]!) };
}

// REDESIGN.md section 5 (the values the mockups use), with the three deliberate departures noted below.
const EXPECTED: ReadonlyArray<readonly [string, string]> = [
  ['--ground', '#eef0ee'],
  ['--surface', '#ffffff'],
  ['--surface-2', '#f6f7f5'],
  ['--sunken', '#e6e9e6'],
  ['--raised', '#ffffff'],
  ['--ink', '#0d1724'],
  ['--ink-2', '#3a4656'],
  // Departure: the design's #65707F is 4.4:1 on the ground; this is 5.1:1 and looks the same.
  ['--ink-3', '#5b6675'],
  ['--line', '#dce0df'],
  ['--line-2', '#c5cbcb'],
  ['--brand', '#2050e6'],
  ['--brand-tint', '#e6ecfd'],
  ['--brand-text', '#1a43c4'],
  ['--tape', '#ffc21f'],
  ['--tape-tint', '#fff3cf'],
  ['--tape-ink', '#5a4200'],
  ['--ok', '#17804a'],
  ['--ok-tint', '#e2f2e8'],
  ['--warn', '#a35f00'],
  ['--warn-tint', '#fcefd9'],
  ['--bad', '#c8352a'],
  ['--bad-tint', '#fbe5e2'],
  ['--info', '#2563c9'],
  ['--info-tint', '#e3ecfa'],
  ['--st-lead', '#5a6b85'],
  ['--st-insp', '#0e7c86'],
  ['--st-prop', '#b86a00'],
  ['--st-won', '#17804a'],
  ['--st-inst', '#3d4c9e'],
  ['--hail-1', '#f7e27a'],
  ['--hail-2', '#f6b547'],
  ['--hail-3', '#ee7a36'],
  ['--hail-4', '#d9455f'],
  ['--hail-5', '#9b2c9e'],
  ['--r-1', '4px'],
  ['--r-2', '6px'],
  ['--r-3', '10px'],
  ['--r-4', '14px'],
  ['--font-size-min', '12px'],
  ['--font-size-body', '14px'],
  // The stacked eighth: stylelint rejects em and max(), so the design's max(12px, .72em) is two tokens.
  ['--font-size-frac', '12px'],
  ['--font-size-frac-lg', '14px'],
];

describe('Chalk Line tokens', () => {
  it('has every token from the design with its value', () => {
    const css = readLight();
    for (const [name, value] of EXPECTED) expect(css.get(name), name).toBe(value);
  });

  it('has one :root block: the legacy S1 and lift blocks are gone', () => {
    expect(CSS.match(/(^|\n):root\s*{/g)?.length).toBe(1);
    const names = [...readLight().keys()];
    expect(names.filter((n) => /^--(ds|lift)-/.test(n))).toEqual([]);
    expect(names).not.toContain('--accent');
    expect(names).not.toContain('--text-muted');
  });

  it('tokens.ts mirrors the light block', () => {
    const css = readLight();
    expect(Object.keys(tokens).length).toBe(css.size);
    for (const [key, value] of Object.entries(tokens)) expect(css.get(`--${key}`), key).toBe(value);
  });

  it('the two dark blocks are the same, and darkTokens mirrors them', () => {
    const { media, attribute } = readDark();
    expect([...media]).toEqual([...attribute]);
    expect(Object.keys(darkTokens).length).toBe(media.size);
    for (const [key, value] of Object.entries(darkTokens)) expect(media.get(`--${key}`), key).toBe(value);
  });

  it('the dark theme only changes tokens the light theme has, and keeps the layout tokens', () => {
    const light = readLight();
    for (const name of readDark().media.keys()) expect(light.has(name), name).toBe(true);
    for (const name of ['--r-3', '--font-size-body', '--f-ui', '--t-mid']) expect(readDark().media.has(name), name).toBe(false);
  });

  it('tokensFor lays the dark changes over the light set', () => {
    expect(tokensFor('light').ground).toBe('#eef0ee');
    expect(tokensFor('dark').ground).toBe('#0a0f16');
    expect(tokensFor('dark')['r-3']).toBe('10px');
    expect(Object.keys(tokensFor('dark'))).toEqual(Object.keys(tokensFor('light')));
  });
});

const rgb = (hex: string): Rgb => {
  const parsed = parseColor(hex);
  if (!parsed) throw new Error(`not a colour: ${hex}`);
  return parsed;
};

/** What status words are: the status colour mixed 20% toward the ink, so they stay AA on their own tint. */
const TEXT_MIX = 0.2;

describe.each([
  ['light', tokensFor('light')],
  ['dark', tokensFor('dark')],
] as const)('contrast, %s theme', (_scheme, t) => {
  const on = (fg: string, bg: string) => contrastRatio(rgb(fg), rgb(bg));

  it('text is 4.5:1 or better on every ground it sits on', () => {
    for (const ground of [t.ground, t.surface, t['surface-2'], t.raised, t.sunken]) {
      expect(on(t.ink, ground)).toBeGreaterThanOrEqual(4.5);
      expect(on(t['ink-2'], ground)).toBeGreaterThanOrEqual(4.5);
      expect(on(t['ink-3'], ground), `ink-3 on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('text on the brand, the tint and the tape is readable', () => {
    expect(on(t['brand-ink'], t.brand)).toBeGreaterThanOrEqual(4.5);
    expect(on(t['brand-text'], t['brand-tint'])).toBeGreaterThanOrEqual(4.5);
    expect(on(t['brand-text'], t.surface)).toBeGreaterThanOrEqual(4.5);
    expect(on(t['tape-ink'], t['tape-tint'])).toBeGreaterThanOrEqual(4.5);
    expect(on(t['bad-ink'], t.bad)).toBeGreaterThanOrEqual(4.5);
  });

  it('status text is the status colour mixed 20% toward the ink, to the nearest value', () => {
    for (const status of ['ok', 'warn', 'bad', 'info'] as const) {
      expect(t[`${status}-text`], status).toBe(toHex(mixRgb(rgb(t[status]), rgb(t.ink), TEXT_MIX)));
    }
  });

  it('status text is 4.5:1 on its own tint and on every ground it sits on', () => {
    for (const status of ['ok', 'warn', 'bad', 'info'] as const) {
      const text = rgb(t[`${status}-text`]);
      for (const ground of [t[`${status}-tint`], t.surface, t['surface-2'], t.ground, t.raised]) {
        expect(contrastRatio(text, rgb(ground)), `${status} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('a toast reads white on graphite, and its accent is the tape colour at 7:1', () => {
    expect(on(t['toast-ink'], t.toast)).toBeGreaterThanOrEqual(7);
    expect(on(t.tape, t.toast)).toBeGreaterThanOrEqual(7);
  });

  it('the edge of a form control is 3:1 against the surface, and the focus ring too', () => {
    expect(on(t['line-ctl'], t.surface)).toBeGreaterThanOrEqual(3);
    expect(on(t.ring, t.surface)).toBeGreaterThanOrEqual(3);
    expect(on(t.ring, t.ground)).toBeGreaterThanOrEqual(3);
  });
});

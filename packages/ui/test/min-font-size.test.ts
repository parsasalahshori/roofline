// @vitest-environment node
import stylelint from 'stylelint';
import { describe, expect, it } from 'vitest';
import plugin from '../stylelint/min-font-size.js';

const RULE = 'roofline/min-font-size';
const TOO_SMALL = 'at least 12px';
const UNSUPPORTED = 'Use px, rem or a var(--font-size-*) token';

async function warningsFor(code: string): Promise<string[]> {
  const { results } = await stylelint.lint({
    code,
    config: { plugins: [plugin], rules: { [RULE]: true } },
  });
  return results[0]!.warnings.map((w) => w.text);
}

describe('roofline/min-font-size', () => {
  const tooSmall = [
    'a{font-size:11px}',
    'a{font-size:0.7rem}',
    'a{font:600 10px/1.2 serif}',
  ];
  const unsupported = [
    'a{font-size:80%}',
    'a{font-size:smaller}',
    'a{font-size:0.8em}',
    'a{font-size:calc(1px + 1vw)}',
  ];
  const good = [
    'a{font-size:12px}',
    'a{font-size:0.75rem}',
    'a{font-size:var(--font-size-body)}',
    'a{font:600 14px/1.4 var(--font)}',
    'a{font-size:28px}',
    // CSS-wide keywords cannot go below a size that is itself checked (initial is medium).
    'a{font-size:inherit}',
    'a{font-size:unset}',
  ];

  it.each(tooSmall)('rejects %s as too small', async (code) => {
    const text = await warningsFor(code);
    expect(text).toHaveLength(1);
    expect(text[0]).toContain(TOO_SMALL);
  });

  it.each(unsupported)('rejects %s as a size it cannot check', async (code) => {
    const text = await warningsFor(code);
    expect(text).toHaveLength(1);
    expect(text[0]).toContain(UNSUPPORTED);
  });

  it.each(good)('accepts %s', async (code) => {
    expect(await warningsFor(code)).toEqual([]);
  });

  it('only a var(--font-size-*) token passes; any other var() is reported', async () => {
    const text = await warningsFor('a{font-size:var(--my-size)}');
    expect(text).toHaveLength(1);
    expect(text[0]).toContain(UNSUPPORTED);
  });

  it('checks the fallback of a font-size token', async () => {
    expect(await warningsFor('a{font-size:var(--font-size-body, 14px)}')).toEqual([]);
    const text = await warningsFor('a{font-size:var(--font-size-body, 11px)}');
    expect(text).toHaveLength(1);
    expect(text[0]).toContain(TOO_SMALL);
  });

  it('checks the size token of the font shorthand, wherever the weight and family sit', async () => {
    expect(await warningsFor('a{font:italic 600 var(--font-size-body)/1.4 var(--font)}')).toEqual([]);
    expect(await warningsFor('a{font:600 14px var(--font)}')).toEqual([]);
    expect(await warningsFor('a{font:inherit}')).toEqual([]);
    const small = await warningsFor('a{font:bold 9px var(--font)}');
    expect(small).toHaveLength(1);
    expect(small[0]).toContain(TOO_SMALL);
    const bad = await warningsFor('a{font:600 var(--my-size)/1.4 var(--font)}');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain(UNSUPPORTED);
  });

  it('accepts the CSS-wide keywords inherit, initial, unset and revert', async () => {
    for (const keyword of ['inherit', 'initial', 'unset', 'revert', 'INHERIT']) {
      expect(await warningsFor(`a{font-size:${keyword}}`), keyword).toEqual([]);
    }
  });

  it('checks the definition of every --font-size-* token, so the var() passthrough is honest', async () => {
    expect(await warningsFor(':root{--font-size-body:14px}')).toEqual([]);
    expect(await warningsFor(':root{--font-size-min:12px;--font-size-label:0.75rem}')).toEqual([]);
    expect(await warningsFor(':root{--font-size-label:var(--font-size-body)}')).toEqual([]);
    const tiny = await warningsFor(':root{--font-size-tiny:11px}');
    expect(tiny).toHaveLength(1);
    expect(tiny[0]).toContain(TOO_SMALL);
    // Redefining a token somewhere narrower is the bypass this guards against.
    const shadowed = await warningsFor('.x{--font-size-body:8px;font-size:var(--font-size-body)}');
    expect(shadowed).toHaveLength(1);
    expect(shadowed[0]).toContain(TOO_SMALL);
    const percent = await warningsFor(':root{--font-size-big:120%}');
    expect(percent).toHaveLength(1);
    expect(percent[0]).toContain(UNSUPPORTED);
  });

  it('leaves custom properties that are not --font-size-* alone', async () => {
    expect(await warningsFor(':root{--tiny:8px;--font-size:8px}')).toHaveLength(0);
  });

  it('reports the declaration even with !important or uppercase', async () => {
    expect(await warningsFor('a{FONT-SIZE:11px !important}')).toHaveLength(1);
  });
});

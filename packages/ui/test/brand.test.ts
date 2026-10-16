import { afterEach, describe, expect, it } from 'vitest';
import {
  applyBrand,
  badShift,
  brandCss,
  contrastRatio,
  deltaE,
  deriveBrand,
  parseColor,
  relativeLuminance,
  toHex,
  type BrandScheme,
} from '../src/brand.ts';

const rgb = (hex: string) => parseColor(hex)!;

/** The three brands the design names: the default, WinChoice's red, and a light yellow that needs dark ink. */
const BLUE = '#2050e6';
const WINCHOICE_RED = '#ed3a2b';
const YELLOW = '#f2b300';

describe('colour maths', () => {
  it('reads #rgb and #rrggbb and nothing else', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255]);
    expect(parseColor('#2050E6')).toEqual([32, 80, 230]);
    for (const bad of ['2050e6', '#12', '#12345', 'red', 'rgb(1,2,3)', '', null, undefined, 4]) expect(parseColor(bad)).toBeNull();
  });

  it('writes lower-case #rrggbb', () => {
    expect(toHex([32, 80, 230])).toBe('#2050e6');
    expect(toHex([300, -4, 12.4])).toBe('#ff000c');
  });

  it('matches the WCAG reference values', () => {
    expect(relativeLuminance(rgb('#ffffff'))).toBeCloseTo(1, 5);
    expect(relativeLuminance(rgb('#000000'))).toBeCloseTo(0, 5);
    expect(contrastRatio(rgb('#ffffff'), rgb('#000000'))).toBeCloseTo(21, 3);
    expect(contrastRatio(rgb('#ffffff'), rgb(WINCHOICE_RED))).toBeCloseTo(4.01, 1);
  });

  it('delta E is 0 for the same colour, small for near colours, large for others', () => {
    expect(deltaE(rgb(BLUE), rgb(BLUE))).toBeCloseTo(0, 5);
    expect(deltaE(rgb(WINCHOICE_RED), rgb('#c8352a'))).toBeLessThan(10);
    expect(deltaE(rgb(BLUE), rgb('#c8352a'))).toBeGreaterThan(40);
  });
});

describe.each([BLUE, WINCHOICE_RED, YELLOW])('brand %s', (color) => {
  describe.each(['light', 'dark'] as const)('in the %s theme', (scheme: BrandScheme) => {
    const palette = deriveBrand(color, scheme)!;
    const surface = rgb(scheme === 'light' ? '#ffffff' : '#111822');

    it('puts readable ink on the brand fill', () => {
      expect(contrastRatio(rgb(palette.brandInk), rgb(palette.brand))).toBeGreaterThanOrEqual(4.5);
    });

    it('keeps brand text and the ring readable on the tint and the surface', () => {
      expect(contrastRatio(rgb(palette.brandText), rgb(palette.brandTint))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(rgb(palette.brandText), surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(rgb(palette.ring), surface)).toBeGreaterThanOrEqual(3);
    });

    it('makes the tint and the line quiet: lighter in the light theme, darker in dark', () => {
      const l = (hex: string) => relativeLuminance(rgb(hex));
      if (scheme === 'light') {
        expect(l(palette.brandTint)).toBeGreaterThan(l(palette.brandLine));
        expect(l(palette.brandLine)).toBeGreaterThan(l(palette.brand) - 0.0001);
      } else {
        expect(l(palette.brandTint)).toBeLessThan(l(palette.brandLine));
      }
    });
  });
});

describe('the default blue', () => {
  it('is the design: white on the fill in light, dark ink on a lighter fill in dark', () => {
    const light = deriveBrand(BLUE, 'light')!;
    expect(light.brand).toBe(BLUE);
    expect(light.brandInk).toBe('#ffffff');
    const dark = deriveBrand(BLUE, 'dark')!;
    expect(deltaE(rgb(dark.brand), rgb('#5b80ff'))).toBeLessThan(6);
    expect(relativeLuminance(rgb(dark.brandInk))).toBeLessThan(0.05);
  });
});

describe('WinChoice red', () => {
  it('keeps white text: the fill darkens just enough to pass instead of switching to black', () => {
    const light = deriveBrand(WINCHOICE_RED, 'light')!;
    expect(light.brandInk).toBe('#ffffff');
    expect(contrastRatio(rgb('#ffffff'), rgb(light.brand))).toBeGreaterThanOrEqual(4.5);
    // Still WinChoice's red, not a different colour.
    expect(deltaE(rgb(light.brand), rgb(WINCHOICE_RED))).toBeLessThan(5);
    expect(light.brand).not.toBe(WINCHOICE_RED);
  });

  it('is too close to --bad in both themes, so --bad moves and holds keep their lock and word', () => {
    expect(badShift(WINCHOICE_RED, 'light')).toBe('#9f251b');
    expect(badShift(WINCHOICE_RED, 'dark')).not.toBeNull();
    const css = brandCss(WINCHOICE_RED)!;
    expect(css).toContain('--bad:#9f251b');
  });

  it('moves the words of a hold with it: --bad-text follows the shifted --bad in both themes', () => {
    const css = brandCss(WINCHOICE_RED)!;
    const light = /--bad:#9f251b;--bad-text:(#[0-9a-f]{6})/.exec(css);
    expect(light).not.toBeNull();
    expect(contrastRatio(rgb(light![1]!), rgb('#fbe5e2'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(rgb(light![1]!), rgb('#ffffff'))).toBeGreaterThanOrEqual(4.5);
    const dark = /--bad:(#[0-9a-f]{6});--bad-text:(#[0-9a-f]{6})/.exec(css.slice(css.indexOf('@media')));
    expect(dark).not.toBeNull();
    expect(contrastRatio(rgb(dark![2]!), rgb('#3a1512'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(rgb(dark![2]!), rgb('#111822'))).toBeGreaterThanOrEqual(4.5);
  });

  it('the shifted --bad is clear of the brand and still readable on the bad tint', () => {
    const shifted = rgb(badShift(WINCHOICE_RED, 'light')!);
    expect(deltaE(rgb(deriveBrand(WINCHOICE_RED, 'light')!.brand), shifted)).toBeGreaterThanOrEqual(10);
    expect(contrastRatio(shifted, rgb('#fbe5e2'))).toBeGreaterThanOrEqual(4.5);
    const dark = rgb(badShift(WINCHOICE_RED, 'dark')!);
    expect(contrastRatio(dark, rgb('#3a1512'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the light yellow', () => {
  it('gets dark ink and keeps its fill, which is the point of computing the ink', () => {
    const light = deriveBrand(YELLOW, 'light')!;
    expect(light.brand).toBe(YELLOW);
    expect(light.brandInk).not.toBe('#ffffff');
    expect(relativeLuminance(rgb(light.brandInk))).toBeLessThan(0.05);
    expect(contrastRatio(rgb(light.brandInk), rgb(YELLOW))).toBeGreaterThanOrEqual(4.5);
  });

  it('does not touch --bad', () => {
    expect(badShift(YELLOW, 'light')).toBeNull();
    expect(brandCss(YELLOW)).not.toContain('--bad');
    expect(brandCss(YELLOW)).not.toContain('--bad-text');
  });
});

describe('blue does not touch --bad either', () => {
  it('is nowhere near the red', () => {
    expect(badShift(BLUE, 'light')).toBeNull();
    expect(badShift(BLUE, 'dark')).toBeNull();
  });
});

describe('brandCss', () => {
  it('gives the light values, then the dark ones under the OS setting and under data-theme', () => {
    const css = brandCss(BLUE)!;
    expect(css.startsWith(':root{--brand:#2050e6;')).toBe(true);
    expect(css).toContain('@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){');
    expect(css).toContain(':root[data-theme="dark"]{');
    expect(css.match(/--brand-ink:/g)).toHaveLength(3);
  });

  it('is null for no colour or a bad one: the default blue stays', () => {
    for (const none of [null, undefined, '', 'blue', '#12', 'javascript:alert(1)', '#fff; } body { display:none']) expect(brandCss(none)).toBeNull();
  });

  it('writes only hex values: nothing from the input reaches the stylesheet unchecked', () => {
    const css = brandCss('#abc')!;
    expect(css.replace(/[{}():;,\-\s\w[\]="#@]/g, '')).toBe('');
  });
});

describe('applyBrand', () => {
  afterEach(() => document.getElementById('roofline-brand')?.remove());

  it('adds one style element, replaces it, and removes it for no colour', () => {
    applyBrand(WINCHOICE_RED);
    const first = document.getElementById('roofline-brand');
    expect(first?.textContent).toContain('--brand:');
    applyBrand(BLUE);
    expect(document.querySelectorAll('#roofline-brand')).toHaveLength(1);
    expect(document.getElementById('roofline-brand')?.textContent).toContain('--brand:#2050e6');
    applyBrand(null);
    expect(document.getElementById('roofline-brand')).toBeNull();
  });

  it('ignores a colour it cannot read and leaves the page as it was', () => {
    applyBrand('not a colour');
    expect(document.getElementById('roofline-brand')).toBeNull();
  });
});

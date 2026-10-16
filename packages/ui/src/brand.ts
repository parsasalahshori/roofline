/*
 * White label (design/REDESIGN.md 7.5). A company brings ONE colour; everything the brand slot needs is
 * derived from it here, light and dark, and checked for contrast:
 *
 *   --brand       the fill of the primary button and the selection edge
 *   --brand-hover its hover fill
 *   --brand-ink   the text on --brand: white, or near-black for a light colour. Always 4.5:1 or better:
 *                 a mid-tone colour (WinChoice red is 4.0:1 under white) is darkened a little until
 *                 white passes, so the button keeps its colour and its white label.
 *   --brand-tint  the colour at 12% on the surface (16% in dark): selected nav, a recommended tier
 *   --brand-line  the colour at 44% on the surface (40% in dark): a ring or border
 *   --brand-text  the colour darkened (lightened in dark) until it is 5.5:1 on the tint: links, selected text
 *   --ring        the focus ring (the same as --brand-text, so it is 3:1 or better on every surface)
 *
 * Nothing else changes per company. The one exception is red: when the company's colour is within
 * delta E 10 (CIEDE2000) of --bad, --bad moves to a darker brick (lighter, in dark) so a hold is never the
 * brand colour; holds keep their lock icon and their word either way.
 *
 * The maths is pure so it can be tested; applyBrand is the one place that touches the document.
 */

export type Rgb = readonly [number, number, number];
type Hsl = readonly [number, number, number];

export type BrandScheme = 'light' | 'dark';

export type BrandPalette = {
  brand: string;
  brandHover: string;
  brandInk: string;
  brandTint: string;
  brandLine: string;
  brandText: string;
  ring: string;
};

/** The ground the dark theme sits on, and the colour its tints are mixed into (tokens.css). */
const SURFACE: Record<BrandScheme, Rgb> = { light: [255, 255, 255], dark: [17, 24, 34] };
/** --bad in each theme, and the tint it sits on. */
const BAD: Record<BrandScheme, { fill: Rgb; tint: Rgb }> = {
  light: { fill: [200, 53, 42], tint: [251, 229, 226] },
  dark: { fill: [255, 111, 97], tint: [58, 21, 18] },
};
/** Where --bad may move when the brand is too close to it, in order of preference. */
const BAD_CANDIDATES: Record<BrandScheme, readonly string[]> = {
  light: ['#9f251b', '#7a1c14'],
  dark: ['#ffa59b', '#ffc2bb'],
};

/** Closer than this to --bad (CIEDE2000) and --bad moves. */
export const BAD_SHIFT_DELTA_E = 10;
/** The ratio text needs on its background (WCAG AA). */
export const TEXT_CONTRAST = 4.5;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** `#rgb` or `#rrggbb` as numbers; null for anything else. */
export function parseColor(input: unknown): Rgb | null {
  if (typeof input !== 'string') return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!match) return null;
  const digits = match[1]!;
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/** `#rrggbb`, lower case. */
export function toHex(rgb: Rgb): string {
  return '#' + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** `amount` of `b` mixed into `a`, in sRGB. */
export function mixRgb(a: Rgb, b: Rgb, amount: number): Rgb {
  return [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount];
}

function rgbToHsl([r, g, b]: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]: Hsl): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    const x = (t + 360) % 360;
    const unit = x / 360;
    if (unit < 1 / 6) return p + (q - p) * 6 * unit;
    if (unit < 1 / 2) return q;
    if (unit < 2 / 3) return p + (q - p) * (2 / 3 - unit) * 6;
    return p;
  };
  return [hue(h + 120) * 255, hue(h) * 255, hue(h - 120) * 255];
}

function toLab(rgb: Rgb): readonly [number, number, number] {
  const [r, g, b] = [channel(rgb[0]), channel(rgb[1]), channel(rgb[2])];
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 colour difference: about 1 is just visible, 10 is "clearly a different colour". */
export function deltaE(a: Rgb, b: Rgb): number {
  const rad = Math.PI / 180;
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cMean = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cMean ** 7 / (cMean ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const hue = (y: number, x: number) => {
    const v = Math.atan2(y, x) / rad;
    return v < 0 ? v + 360 : v;
  };
  const h1 = c1p === 0 ? 0 : hue(b1, a1p);
  const h2 = c2p === 0 ? 0 : hue(b2, a2p);
  const dl = l2 - l1;
  const dc = c2p - c1p;
  let dh = 0;
  if (c1p * c2p !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(c1p * c2p) * Math.sin((dh * rad) / 2);
  const lMean = (l1 + l2) / 2;
  const cpMean = (c1p + c2p) / 2;
  let hMean = h1 + h2;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1 - h2) <= 180) hMean = (h1 + h2) / 2;
    else hMean = h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos((hMean - 30) * rad) +
    0.24 * Math.cos(2 * hMean * rad) +
    0.32 * Math.cos((3 * hMean + 6) * rad) -
    0.2 * Math.cos((4 * hMean - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hMean - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cpMean ** 7 / (cpMean ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lMean - 50) ** 2) / Math.sqrt(20 + (lMean - 50) ** 2);
  const sc = 1 + 0.045 * cpMean;
  const sh = 1 + 0.015 * cpMean * t;
  const rt = -Math.sin(2 * dTheta * rad) * rc;
  return Math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh));
}

/** The near-black (or, in dark, ink-coloured) text for a light fill: the fill's own hue, very dark. */
function darkInk(base: Rgb): Rgb {
  const [h] = rgbToHsl(base);
  return hslToRgb([h, 0.4, 0.08]);
}

/** `rgb` mixed toward black, 1% at a time, until `ok` is true: the same colour, only deeper (HSL lightness would shift its saturation). */
function darkenUntil(rgb: Rgb, ok: (candidate: Rgb) => boolean): Rgb {
  let candidate = rgb;
  for (let percent = 1; percent <= 60 && !ok(candidate); percent += 1) candidate = mixRgb(rgb, [0, 0, 0], percent / 100);
  return candidate;
}

/** `rgb` moved by `step` in lightness until `ok` is true (or the lightness runs out). */
function shiftUntil(rgb: Rgb, step: number, ok: (candidate: Rgb) => boolean): Rgb {
  const [h, s, start] = rgbToHsl(rgb);
  let l = start;
  let candidate = rgb;
  for (let i = 0; i < 200 && !ok(candidate); i += 1) {
    l = clamp(l + step, 0, 1);
    candidate = hslToRgb([h, s, l]);
    if (l === 0 || l === 1) break;
  }
  return candidate;
}

/**
 * The slot for one colour in one theme. Null when `color` is not #rgb or #rrggbb.
 * Light: the fill is the colour, darkened only if white text cannot reach 4.5:1 on it and the colour is
 * not light enough for dark text. Dark: the colour is raised to about 66% lightness and gets dark text.
 */
export function deriveBrand(color: string, scheme: BrandScheme): BrandPalette | null {
  const raw = parseColor(color);
  if (!raw) return null;
  const surface = SURFACE[scheme];
  const [h, s, l] = rgbToHsl(raw);

  let fill: Rgb;
  let ink: Rgb;
  if (scheme === 'light') {
    const white: Rgb = [255, 255, 255];
    const dark = darkInk(raw);
    if (contrastRatio(white, raw) >= TEXT_CONTRAST) {
      fill = raw;
      ink = white;
    } else if (relativeLuminance(raw) >= 0.3 && contrastRatio(dark, raw) >= TEXT_CONTRAST) {
      fill = raw;
      ink = dark;
    } else {
      fill = darkenUntil(raw, (c) => contrastRatio(white, c) >= TEXT_CONTRAST);
      ink = white;
    }
  } else {
    fill = hslToRgb([h, clamp(Math.max(s, 0.6) + 0.15, 0, 1), Math.max(l, 0.66)]);
    ink = darkInk(fill);
    if (contrastRatio(ink, fill) < TEXT_CONTRAST) ink = [0, 0, 0];
  }

  const [fh, fs, fl] = rgbToHsl(fill);
  const hover = hslToRgb([fh, fs, clamp(fl + (scheme === 'light' ? -0.06 : 0.06), 0, 1)]);
  const tint = mixRgb(surface, scheme === 'light' ? raw : fill, scheme === 'light' ? 0.12 : 0.16);
  const line = mixRgb(surface, scheme === 'light' ? raw : fill, scheme === 'light' ? 0.44 : 0.4);
  const text = shiftUntil(fill, scheme === 'light' ? -0.01 : 0.01, (c) => contrastRatio(c, tint) >= 5.5);

  return {
    brand: toHex(fill),
    brandHover: toHex(hover),
    brandInk: toHex(ink),
    brandTint: toHex(tint),
    brandLine: toHex(line),
    brandText: toHex(text),
    ring: toHex(text),
  };
}

/** Where --bad must move for this colour in this theme: null when the colour is clear of it. */
export function badShift(color: string, scheme: BrandScheme): string | null {
  const raw = parseColor(color);
  if (!raw) return null;
  const palette = deriveBrand(color, scheme);
  const compared = parseColor(palette?.brand) ?? raw;
  const { fill, tint } = BAD[scheme];
  if (Math.min(deltaE(compared, fill), deltaE(raw, fill)) >= BAD_SHIFT_DELTA_E) return null;
  for (const candidate of BAD_CANDIDATES[scheme]) {
    const rgb = parseColor(candidate)!;
    if (deltaE(compared, rgb) >= BAD_SHIFT_DELTA_E && contrastRatio(rgb, tint) >= TEXT_CONTRAST) return candidate;
  }
  return BAD_CANDIDATES[scheme][0]!;
}

function declarations(palette: BrandPalette, bad: string | null): string {
  return (
    `--brand:${palette.brand};--brand-hover:${palette.brandHover};--brand-ink:${palette.brandInk};` +
    `--brand-tint:${palette.brandTint};--brand-line:${palette.brandLine};--brand-text:${palette.brandText};--ring:${palette.ring};` +
    (bad ? `--bad:${bad};` : '')
  );
}

/**
 * The CSS that fills the brand slot for one colour: the light values, then the dark ones under the OS setting
 * and under data-theme="dark" (the same order and selectors as tokens.css, so it wins by coming after it).
 * Null for a colour that is not #rgb or #rrggbb: the default blue stays.
 */
export function brandCss(color: string | null | undefined): string | null {
  if (!color) return null;
  const light = deriveBrand(color, 'light');
  const dark = deriveBrand(color, 'dark');
  if (!light || !dark) return null;
  const lightBlock = declarations(light, badShift(color, 'light'));
  const darkBlock = declarations(dark, badShift(color, 'dark'));
  return (
    `:root{${lightBlock}}` +
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${darkBlock}}}` +
    `:root[data-theme="dark"]{${darkBlock}}`
  );
}

const STYLE_ID = 'roofline-brand';

/**
 * Puts the company's colour into the page, or takes it out again (null: back to the default blue).
 * One <style> element, replaced each time, at the end of <head> so it follows tokens.css.
 */
export function applyBrand(color: string | null | undefined, doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (!doc) return;
  const css = brandCss(color);
  let el = doc.getElementById(STYLE_ID);
  if (css === null) {
    el?.remove();
    return;
  }
  if (!el) {
    el = doc.createElement('style');
    el.id = STYLE_ID;
  }
  el.textContent = css;
  // Appended (or moved) last, so it follows any stylesheet added after it.
  doc.head.appendChild(el);
}

import { Resvg } from '@resvg/resvg-js';
import type { Config } from '../config.ts';
import type { AdImageRenderer } from './ad-image.ts';

const SIZE = 1080;
const MAX_NAME_CHARS = 60;
const HEX = /^#[0-9a-fA-F]{6}$/;
const FALLBACK_COLOR = '#1d4ed8';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Greedy word wrap into at most `maxLines` lines of `perLine` characters; the last line is cut with an ellipsis. */
function wrap(text: string, perLine: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    const piece = word.length > perLine ? `${word.slice(0, perLine - 1)}…` : word;
    if (current === '') current = piece;
    else if (current.length + 1 + piece.length <= perLine) current = `${current} ${piece}`;
    else {
      lines.push(current);
      current = piece;
    }
  }
  if (current !== '') lines.push(current);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1]!;
    kept[maxLines - 1] = `${last.length >= perLine ? last.slice(0, perLine - 1) : last}…`;
    return kept;
  }
  return lines;
}

/** The SVG for the card: a colour field, a lighter band, the company name large and the line below it. */
export function cardSvg(input: { companyName: string; line: string; colorHex: string }): string {
  const color = HEX.test(input.colorHex) ? input.colorHex : FALLBACK_COLOR;
  const name = input.companyName.trim().slice(0, MAX_NAME_CHARS * 2);
  const fontSize = name.length <= 14 ? 120 : name.length <= 28 ? 88 : 64;
  // Average glyph width is about 0.55 em; keep the text inside a 900 px column.
  const perLine = Math.max(8, Math.floor(900 / (fontSize * 0.55)));
  const nameLines = wrap(name, perLine, 3);
  const lineHeight = Math.round(fontSize * 1.15);
  const blockHeight = lineHeight * nameLines.length;
  const firstBaseline = Math.round(480 - blockHeight / 2 + fontSize * 0.85);
  const nameTspans = nameLines
    .map((l, i) => `<tspan x="540" y="${firstBaseline + i * lineHeight}">${escapeXml(l)}</tspan>`)
    .join('');
  const subLines = wrap(input.line.trim(), 40, 2);
  const subStart = firstBaseline + (nameLines.length - 1) * lineHeight + 120;
  const subTspans = subLines.map((l, i) => `<tspan x="540" y="${subStart + i * 64}">${escapeXml(l)}</tspan>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<rect width="${SIZE}" height="${SIZE}" fill="${color}"/>
<rect y="${SIZE - 220}" width="${SIZE}" height="220" fill="#ffffff" fill-opacity="0.18"/>
<text text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="${fontSize}" fill="#ffffff">${nameTspans}</text>
<text text-anchor="middle" font-family="sans-serif" font-size="52" fill="#ffffff">${subTspans}</text>
</svg>`;
}

/** The real ad-card renderer: a 1080 x 1080 PNG with the company name and a short line. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the renderer needs no configuration
export function resvgCardFor(_config: Config): AdImageRenderer {
  return {
    async card(input): Promise<Uint8Array> {
      const resvg = new Resvg(cardSvg(input), {
        fitTo: { mode: 'width', value: SIZE },
        font: { loadSystemFonts: true, defaultFontFamily: 'sans-serif' },
      });
      return new Uint8Array(resvg.render().asPng());
    },
  };
}

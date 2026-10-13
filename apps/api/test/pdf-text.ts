import { inflateSync } from 'node:zlib';

/**
 * The text of a PDF: PDFKit writes Helvetica text as hex strings inside TJ arrays, split by kerning, and
 * compresses page streams with Flate. Inflates every stream it can, joins each array's pieces, then joins
 * all arrays with single spaces, so a sentence that wraps across lines still reads as one string.
 *
 * Each stream is cut by its dictionary's /Length, never by searching for "endstream": compressed bytes can end in
 * a carriage return, and a `\r?\nendstream` pattern would then drop that byte, the inflate would fail, and the
 * page's text would vanish (about 1 stream in 256; the signed-pdf flake of 2026-10-12).
 */
export function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1');
  const bodies = [raw];
  for (const m of raw.matchAll(/\/Length (\d+)\b[^]*?>>\s*stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const data = raw.slice(start, start + Number(m[1]));
    try {
      bodies.push(inflateSync(Buffer.from(data, 'latin1')).toString('latin1'));
    } catch {
      // Not a Flate stream (an image's raw data, say).
    }
  }
  const pieces: string[] = [];
  for (const body of bodies) {
    for (const m of body.matchAll(/\[([^\]]*)\] TJ/g)) {
      pieces.push(Buffer.from([...m[1]!.matchAll(/<([0-9a-f]*)>/g)].map((h) => h[1]).join(''), 'hex').toString('latin1'));
    }
  }
  return pieces.join(' ').replace(/\s+/g, ' ');
}

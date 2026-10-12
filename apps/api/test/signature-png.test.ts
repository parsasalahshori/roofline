import { crc32, deflateSync } from 'node:zlib';
import PDFDocument from 'pdfkit';
import { describe, expect, test } from 'vitest';
import {
  BadSignaturePng,
  decodeSignaturePng,
  flattenSignaturePng,
  isAcceptableSignaturePng,
  MAX_SIGNATURE_PNG_BYTES,
} from '../src/estimator/signature-png.ts';
import { pdfToBuffer } from '../src/proposals/pdf.ts';

// The drawn-signature PNG check (review A-C1). Pure: no database.

const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// A 1x1 RGBA PNG, as a browser canvas makes them.
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(width: number, height: number, colourType: number, idat: Buffer, o: { bitDepth?: number; interlace?: number } = {}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = o.bitDepth ?? 8;
  ihdr[9] = colourType;
  ihdr[12] = o.interlace ?? 0;
  return Buffer.concat([MAGIC, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** A fully transparent RGBA image: every row filter 0, every pixel (0,0,0,0). */
const transparent = (w: number, h: number): Buffer => png(w, h, 6, deflateSync(Buffer.alloc(h * (1 + w * 4))));

/** Embeds the image with pdfkit and collects the document; rejects on any error. */
async function embed(image: Buffer): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER' });
  doc.image(image, 48, 48, { fit: [220, 90] });
  return pdfToBuffer(doc);
}

describe('decodeSignaturePng', () => {
  test('accepts a browser PNG and a fully transparent RGBA PNG', () => {
    expect(isAcceptableSignaturePng(TINY_PNG)).toBe(true);
    const clear = decodeSignaturePng(transparent(600, 240));
    expect(clear).toMatchObject({ width: 600, height: 240, channels: 4 });
    expect(clear.pixels.every((b) => b === 0)).toBe(true);
    expect(isAcceptableSignaturePng(png(3, 2, 2, deflateSync(Buffer.alloc(2 * (1 + 3 * 3)))))).toBe(true);
  });

  test('refuses the PNG magic followed by junk', () => {
    const junk = Buffer.concat([Buffer.from('\x89PNG', 'latin1'), Buffer.from('this is not the rest of a png at all')]);
    expect(() => decodeSignaturePng(junk)).toThrow(BadSignaturePng);
    expect(isAcceptableSignaturePng(Buffer.concat([MAGIC, Buffer.from('junk junk junk junk junk junk')]))).toBe(false);
  });

  test('refuses image data that is not zlib, is short, is long, or has an unknown row filter', () => {
    expect(isAcceptableSignaturePng(png(4, 2, 6, Buffer.from('notzlibdata')))).toBe(false);
    expect(isAcceptableSignaturePng(png(4, 2, 6, deflateSync(Buffer.alloc(10))))).toBe(false);
    expect(isAcceptableSignaturePng(png(4, 2, 6, deflateSync(Buffer.alloc(1000))))).toBe(false);
    expect(isAcceptableSignaturePng(png(1, 1, 6, deflateSync(Buffer.from([9, 1, 2, 3, 4]))))).toBe(false);
  });

  test('refuses oversized images, by dimensions and by bytes, and a decompression bomb', () => {
    expect(isAcceptableSignaturePng(png(2001, 1, 6, deflateSync(Buffer.alloc(1 + 2001 * 4))))).toBe(false);
    expect(isAcceptableSignaturePng(png(1, 1001, 2, deflateSync(Buffer.alloc(1001 * 4))))).toBe(false);
    expect(isAcceptableSignaturePng(png(2000, 1000, 6, deflateSync(Buffer.alloc(50_000_000))))).toBe(false);
    const padded = Buffer.concat([TINY_PNG.subarray(0, TINY_PNG.length - 12), chunk('tEXt', Buffer.alloc(MAX_SIGNATURE_PNG_BYTES)), TINY_PNG.subarray(TINY_PNG.length - 12)]);
    expect(isAcceptableSignaturePng(padded)).toBe(false);
  });

  test('refuses other bit depths, colour types, interlacing, a bad CRC, a missing IEND and IHDR not first', () => {
    const rows = deflateSync(Buffer.alloc(1 + 4));
    expect(isAcceptableSignaturePng(png(1, 1, 6, rows, { bitDepth: 16 }))).toBe(false);
    expect(isAcceptableSignaturePng(png(1, 1, 3, rows))).toBe(false);
    expect(isAcceptableSignaturePng(png(1, 1, 6, rows, { interlace: 1 }))).toBe(false);
    const badCrc = Buffer.from(TINY_PNG);
    badCrc[29] = (badCrc[29]! + 1) & 0xff;
    expect(isAcceptableSignaturePng(badCrc)).toBe(false);
    expect(isAcceptableSignaturePng(TINY_PNG.subarray(0, TINY_PNG.length - 12))).toBe(false);
    const ihdrSecond = Buffer.concat([MAGIC, chunk('tEXt', Buffer.from('a')), TINY_PNG.subarray(8)]);
    expect(isAcceptableSignaturePng(ihdrSecond)).toBe(false);
  });
});

describe('flattenSignaturePng', () => {
  test('gives a valid RGB PNG on white that pdfkit embeds', async () => {
    const flat = flattenSignaturePng(transparent(40, 20));
    const decoded = decodeSignaturePng(flat);
    expect(decoded).toMatchObject({ width: 40, height: 20, channels: 3 });
    expect(decoded.pixels.every((b) => b === 255)).toBe(true);
    const pdf = await embed(flattenSignaturePng(TINY_PNG));
    expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  test('throws BadSignaturePng for a corrupt image instead of handing it on', () => {
    expect(() => flattenSignaturePng(png(4, 2, 6, Buffer.from('notzlibdata')))).toThrow(BadSignaturePng);
  });
});

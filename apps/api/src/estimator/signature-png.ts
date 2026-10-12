import { crc32, deflateSync, inflateSync } from 'node:zlib';

/*
 * The drawn signature is a PNG from the homeowner's browser, so it is untrusted bytes. pdfkit (png-js)
 * decodes an alpha PNG with an async inflate that throws inside its callback, which no caller can catch:
 * a bad image would crash the process. So every drawn signature is checked in full here, before it is
 * stored or signed, and again before a PDF is drawn; and the PDF draws a flattened copy (RGB on white,
 * filter 0) that pdfkit embeds without decoding anything.
 */

/** The largest drawn signature accepted, in bytes (the sign route's base64 cap is 200,000 characters). */
export const MAX_SIGNATURE_PNG_BYTES = 150_000;
export const MAX_SIGNATURE_WIDTH = 2000;
export const MAX_SIGNATURE_HEIGHT = 1000;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR_LENGTH = 13;
/** Chunk header (length + type) plus the CRC. */
const CHUNK_OVERHEAD = 12;

export type SignaturePixels = { width: number; height: number; channels: 3 | 4; pixels: Buffer };

/** Thrown for any PNG this app will not accept; the message is never shown to the homeowner. */
export class BadSignaturePng extends Error {
  constructor(reason: string) {
    super(`Bad signature PNG: ${reason}`);
    this.name = 'BadSignaturePng';
  }
}

const bad = (reason: string): BadSignaturePng => new BadSignaturePng(reason);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Checks a drawn signature PNG in full and returns its pixels: the 8-byte signature, IHDR first,
 * width ≤ 2000 and height ≤ 1000, bit depth 8, colour type 2 (RGB) or 6 (RGBA), no interlace, every
 * chunk inside the buffer with a good CRC, IEND last, and the IDAT data inflating (output capped) to
 * exactly height × (1 + width × channels) bytes with a known filter on every row. Throws BadSignaturePng.
 */
export function decodeSignaturePng(png: Uint8Array): SignaturePixels {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (buf.length > MAX_SIGNATURE_PNG_BYTES) throw bad('too large');
  if (buf.length < SIGNATURE.length + CHUNK_OVERHEAD + IHDR_LENGTH || !buf.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw bad('not a PNG');

  let pos = SIGNATURE.length;
  let header: { width: number; height: number; channels: 3 | 4 } | null = null;
  const idat: Buffer[] = [];
  let ended = false;
  while (pos < buf.length) {
    if (ended) throw bad('data after IEND');
    if (pos + CHUNK_OVERHEAD > buf.length) throw bad('truncated chunk');
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const end = pos + 8 + length;
    if (length > buf.length || end + 4 > buf.length) throw bad('truncated chunk');
    if (crc32(buf.subarray(pos + 4, end)) !== buf.readUInt32BE(end)) throw bad('bad CRC');
    const data = buf.subarray(pos + 8, end);
    if (header === null) {
      if (type !== 'IHDR' || length !== IHDR_LENGTH) throw bad('IHDR is not first');
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const [bitDepth, colourType, compression, filter, interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (width < 1 || height < 1 || width > MAX_SIGNATURE_WIDTH || height > MAX_SIGNATURE_HEIGHT) throw bad('size');
      if (bitDepth !== 8) throw bad('bit depth');
      if (colourType !== 2 && colourType !== 6) throw bad('colour type');
      if (compression !== 0 || filter !== 0 || interlace !== 0) throw bad('method or interlace');
      header = { width, height, channels: colourType === 6 ? 4 : 3 };
    } else if (type === 'IHDR') {
      throw bad('second IHDR');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
    }
    pos = end + 4;
  }
  if (header === null || !ended || idat.length === 0) throw bad('missing chunks');
  const { width, height, channels } = header;

  const stride = width * channels;
  const expected = height * (1 + stride);
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch {
    throw bad('image data');
  }
  if (raw.length !== expected) throw bad('image data length');

  // Unfilter, row by row (PNG filter method 0), checking each row's filter type.
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (1 + stride)]!;
    if (filter > 4) throw bad('filter type');
    const src = y * (1 + stride) + 1;
    const out = y * stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? pixels[out + i - channels]! : 0;
      const up = y > 0 ? pixels[out - stride + i]! : 0;
      const upLeft = y > 0 && i >= channels ? pixels[out - stride + i - channels]! : 0;
      const x = raw[src + i]!;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + left;
      else if (filter === 2) v = x + up;
      else if (filter === 3) v = x + ((left + up) >> 1);
      else v = x + paeth(left, up, upLeft);
      pixels[out + i] = v & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/** True when `decodeSignaturePng` accepts the bytes. */
export function isAcceptableSignaturePng(png: Uint8Array): boolean {
  try {
    decodeSignaturePng(png);
    return true;
  } catch {
    return false;
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * The checked signature as a plain RGB PNG composited on white, every row filter 0. pdfkit embeds this
 * kind of PNG as it is (no alpha to split, so no async decode). Throws BadSignaturePng for a bad input.
 */
export function flattenSignaturePng(png: Uint8Array): Buffer {
  const { width, height, channels, pixels } = decodeSignaturePng(png);
  const rows = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    rows[o++] = 0;
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * channels;
      const alpha = channels === 4 ? pixels[p + 3]! : 255;
      for (let c = 0; c < 3; c += 1) {
        // Over white: c·a + 255·(1 − a), rounded.
        rows[o++] = Math.round((pixels[p + c]! * alpha + 255 * (255 - alpha)) / 255);
      }
    }
  }
  const ihdr = Buffer.alloc(IHDR_LENGTH);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

import { crc32, deflateSync } from 'node:zlib';

/*
 * A plain RGB PNG (8 bits a channel, no filtering, one deflated IDAT), for Google's aerial photo of a 3D roof.
 */

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
  return out;
}

/** `rgb` is width x height x 3 bytes, row by row from the top. */
export function encodeRgbPng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  if (!(width > 0 && height > 0) || rgb.length !== width * height * 3) throw new Error('Bad RGB image size.');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let r = 0; r < height; r++) {
    const at = r * (width * 3 + 1);
    rows[at] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + r * width * 3, width * 3).copy(rows, at + 1);
  }
  return Buffer.concat([Buffer.from(SIGNATURE), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 6 })), chunk('IEND', new Uint8Array(0))]);
}

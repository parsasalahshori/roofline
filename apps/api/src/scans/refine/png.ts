import { deflateSync } from 'node:zlib';

/*
 * The AI mask of a frame as a small PNG the reviewer's screen lays over the photo: transparent where the window is not, a
 * translucent blue where it is, and a firmer blue line along its edge. Hand-written (zlib is in Node) so no image library is
 * needed. Scaled down to at most `maxWidth` pixels wide, nearest neighbour: a mask is a shape, not a picture.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Apple's system blue, as the overlay's tint. */
export const MASK_RGB = [10, 132, 255] as const;
export const MASK_FILL_ALPHA = 96;
export const MASK_EDGE_ALPHA = 235;

/** A tinted RGBA PNG of a 0/1 mask (`w` x `h`, row-major), at most `maxWidth` wide. */
export function encodeMaskPng(mask: Uint8Array, w: number, h: number, maxWidth = 640): { png: Uint8Array; width: number; height: number } {
  const scale = Math.min(1, maxWidth / w);
  const ow = Math.max(1, Math.round(w * scale));
  const oh = Math.max(1, Math.round(h * scale));
  const small = new Uint8Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / oh));
    for (let x = 0; x < ow; x++) small[y * ow + x] = mask[sy * w + Math.min(w - 1, Math.floor(((x + 0.5) * w) / ow))] ? 1 : 0;
  }
  const raw = Buffer.alloc((ow * 4 + 1) * oh);
  for (let y = 0; y < oh; y++) {
    const row = y * (ow * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < ow; x++) {
      if (small[y * ow + x] === 0) continue;
      const edge = x === 0 || y === 0 || x === ow - 1 || y === oh - 1 || small[y * ow + x - 1] === 0 || small[y * ow + x + 1] === 0 || small[(y - 1) * ow + x] === 0 || small[(y + 1) * ow + x] === 0;
      const i = row + 1 + x * 4;
      raw[i] = MASK_RGB[0];
      raw[i + 1] = MASK_RGB[1];
      raw[i + 2] = MASK_RGB[2];
      raw[i + 3] = edge ? MASK_EDGE_ALPHA : MASK_FILL_ALPHA;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ow, 0);
  ihdr.writeUInt32BE(oh, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))]);
  return { png: new Uint8Array(png), width: ow, height: oh };
}

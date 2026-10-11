import { describe, expect, test } from 'vitest';
import { decrypt, encrypt } from '../src/crypto.ts';

/** Not secrets: 32 bytes of 0x01 and of 0x02, base64. */
const KEY = Buffer.alloc(32, 1).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 2).toString('base64');

describe('encrypt / decrypt (AES-256-GCM, iv(12) | tag(16) | ciphertext)', () => {
  test('round trip', () => {
    const box = encrypt('subaccount-auth-token-123', KEY);
    expect(Buffer.isBuffer(box)).toBe(true);
    expect(decrypt(box, KEY)).toBe('subaccount-auth-token-123');
  });

  test('the layout: a 12-byte IV, a 16-byte tag, then the ciphertext (as long as the UTF-8 text)', () => {
    const plain = 'héllo wörld ✓';
    const box = encrypt(plain, KEY);
    expect(box.length).toBe(12 + 16 + Buffer.byteLength(plain, 'utf8'));
    expect(box.subarray(28).toString('utf8')).not.toBe(plain);
  });

  test('an empty string round-trips', () => {
    const box = encrypt('', KEY);
    expect(box.length).toBe(28);
    expect(decrypt(box, KEY)).toBe('');
  });

  test('every call uses a fresh IV, so the same text never encrypts the same way twice', () => {
    const a = encrypt('same', KEY);
    const b = encrypt('same', KEY);
    expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false);
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, KEY)).toBe('same');
    expect(decrypt(b, KEY)).toBe('same');
  });

  test('the wrong key throws', () => {
    const box = encrypt('secret', KEY);
    expect(() => decrypt(box, OTHER_KEY)).toThrow();
  });

  test.each([
    ['the IV', 0],
    ['the tag', 12],
    ['the ciphertext', 28],
    ['the last byte', -1],
  ])('a flipped bit in %s throws', (_where, at) => {
    const box = encrypt('secret token', KEY);
    const i = at < 0 ? box.length + at : at;
    box[i] = box[i]! ^ 0x01;
    expect(() => decrypt(box, KEY)).toThrow();
  });

  test('a truncated box throws', () => {
    const box = encrypt('secret token', KEY);
    expect(() => decrypt(box.subarray(0, box.length - 1), KEY)).toThrow();
    expect(() => decrypt(box.subarray(0, 27), KEY)).toThrow();
    expect(() => decrypt(Buffer.alloc(0), KEY)).toThrow();
  });

  test('a key that is not 32 bytes of base64 throws, both ways', () => {
    const short = Buffer.alloc(16, 1).toString('base64');
    expect(() => encrypt('x', short)).toThrow();
    expect(() => decrypt(encrypt('x', KEY), short)).toThrow();
    expect(() => encrypt('x', 'not base64 at all!')).toThrow();
  });
});

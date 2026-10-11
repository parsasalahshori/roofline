import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/*
 * Secrets kept in the database (a texting subaccount's auth token, an integration's credentials)
 * are stored as AES-256-GCM boxes: `iv (12 bytes) | auth tag (16 bytes) | ciphertext`. The key is
 * ENCRYPTION_KEY, 32 random bytes, base64. GCM authenticates the box, so a wrong key, a flipped bit
 * or a truncated box makes `decrypt` throw instead of returning garbage.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The 32-byte key from its base64 form; anything else throws (the message never includes the key). */
function keyFrom(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32 || key.toString('base64') !== keyB64) {
    throw new Error('The encryption key must be 32 bytes, base64-encoded.');
  }
  return key;
}

/** Encrypts `plain` (UTF-8) under the key, with a fresh random IV every time. */
export function encrypt(plain: string, keyB64: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(keyB64), iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Opens a box made by `encrypt`. Throws when the key is wrong or the box was changed or cut short. */
export function decrypt(box: Buffer, keyB64: string): string {
  const key = keyFrom(keyB64);
  if (box.length < IV_BYTES + TAG_BYTES) throw new Error('The encrypted value is too short to be one.');
  const iv = box.subarray(0, IV_BYTES);
  const tag = box.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(box.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
}

import { hkdfSync } from 'node:crypto';

/**
 * The HMAC key for unsubscribe tokens (see unsubscribe-token.ts). The app has no separate session
 * secret, so the key is derived from ENCRYPTION_KEY (always set) with HKDF and the info `unsubscribe`:
 * it never equals the encryption key, and rotating ENCRYPTION_KEY invalidates old links.
 * Everything that signs or checks an unsubscribe token (the email sender, the page, the Postmark
 * webhook) must take its key from here.
 */
export function unsubscribeKey(config: { ENCRYPTION_KEY: string }): string {
  const ikm = Buffer.from(config.ENCRYPTION_KEY, 'base64');
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'unsubscribe', 32)).toString('base64url');
}

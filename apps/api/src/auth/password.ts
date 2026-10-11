import { randomBytes, scrypt, scryptSync, type ScryptOptions, timingSafeEqual } from 'node:crypto';

/**
 * Password hashes are `scrypt$N$r$p$<salt base64>$<hash base64>` (a 64-byte key and a 16-byte
 * salt). The same format is written by the test seed (packages/db/src/testing/seed.ts), and
 * `verifyPassword` reads the cost parameters from the stored string, so raising them later does
 * not lock out hashes written with the old ones.
 */
export const COST = { N: 16384, r: 8, p: 1 } as const;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

/** Upper bounds on the cost parameters read from a stored hash, so a corrupted row cannot ask for gigabytes. */
const MAX_N = 2 ** 17;
const MAX_R = 16;
const MAX_P = 4;

function derive(password: string, salt: Buffer, keyBytes: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyBytes, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function format(salt: Buffer, key: Buffer): string {
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** scrypt with a random salt. Passwords are hashed exactly as typed (no trimming or normalising). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, COST);
  return format(salt, key);
}

function wholeNumber(text: string | undefined): number | null {
  return text !== undefined && /^\d{1,10}$/.test(text) ? Number(text) : null;
}

/**
 * True when `password` produces the stored hash. Compares in constant time. A stored value that is
 * not a hash this app could have written is simply "no match": this never throws for bad input.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, nText, rText, pText, saltText, keyText, ...extra] = stored.split('$');
  if (scheme !== 'scrypt' || extra.length > 0) return false;
  const N = wholeNumber(nText);
  const r = wholeNumber(rText);
  const p = wholeNumber(pText);
  if (N === null || r === null || p === null) return false;
  if (N < 2 || N > MAX_N || (N & (N - 1)) !== 0 || r < 1 || r > MAX_R || p < 1 || p > MAX_P) return false;
  if (!saltText || !keyText) return false;
  const salt = Buffer.from(saltText, 'base64');
  const expected = Buffer.from(keyText, 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    // 128 * N * r bytes is what scrypt needs; leave room for the p-dependent buffers on top.
    actual = await derive(password, salt, expected.length, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
  } catch {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

/**
 * A valid hash of a password nobody knows, made when this module loads from the same COST and key
 * and salt sizes as every real hash, so it can never drift from them when COST is raised.
 * The salt is fixed; the password is 32 random bytes that are never kept.
 * Login checks the typed password against this when the email has no account, or the account has
 * no password, so those requests spend the same scrypt time as a wrong password and the response
 * time does not reveal which emails have accounts. (It is never a way in: those requests are
 * refused whatever the check returns.)
 */
export const DUMMY_PASSWORD_HASH = (() => {
  const salt = Buffer.alloc(SALT_BYTES, 0x5a);
  return format(salt, scryptSync(randomBytes(32), salt, KEY_BYTES, COST));
})();

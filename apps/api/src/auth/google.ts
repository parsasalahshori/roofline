import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { AppError, MESSAGES } from '../errors.ts';

/** What Google vouches for about the person who signed in. */
export type GoogleClaims = {
  /** Google's permanent, unique id for the account. It never changes, even when the email does. */
  sub: string;
  email: string;
  /** Whether Google has confirmed the person controls `email`. Linking and sign-up depend on it. */
  emailVerified: boolean;
  name: string;
};

/**
 * Turns the credential Google's sign-in button hands the browser (a signed ID token) into claims,
 * or throws a 401 AppError. Tests inject a fake; the server uses `JoseGoogleVerifier`.
 */
export type GoogleVerifier = { verify(credential: string): Promise<GoogleClaims> };

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/**
 * Google's public signing keys. One set for the whole process: jose fetches them on first use,
 * keeps them (honouring Google's cache headers) and re-fetches when a token names a key it does
 * not have yet. Creating it makes no request.
 */
const GOOGLE_KEYS = createRemoteJWKSet(new URL(GOOGLE_CERTS_URL));

export type JoseGoogleVerifierOptions = {
  /** Where the signing keys come from. Tests pass a local key set so nothing calls Google. */
  keys?: JWTVerifyGetKey;
};

function localPart(email: string): string {
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

/** Reads the claims we use out of a token whose signature, issuer, audience and expiry already checked out. */
function claimsOf(payload: JWTPayload): GoogleClaims {
  const { sub, email, email_verified: verified, name } = payload;
  if (typeof sub !== 'string' || sub === '' || typeof email !== 'string' || email.trim() === '') {
    throw new AppError(401, MESSAGES.googleFailed);
  }
  return {
    sub,
    email,
    // Google sends a boolean; older tokens have sent the string "true". Anything else is not a yes.
    emailVerified: verified === true || verified === 'true',
    name: typeof name === 'string' && name.trim() !== '' ? name.trim() : localPart(email),
  };
}

/**
 * Checks Google ID tokens: the signature against Google's published keys, the issuer, the
 * audience (our own client id, so a token Google made for another app is refused), and that it has
 * not expired. Every failure, whatever its cause, is the same 401 with the same plain sentence.
 */
export class JoseGoogleVerifier implements GoogleVerifier {
  private readonly clientId: string | undefined;
  private readonly keys: JWTVerifyGetKey;

  /** `clientId` is `GOOGLE_CLIENT_ID`; when it is unset every call is a 503 (Google sign-in is not set up). */
  constructor(clientId: string | undefined, options: JoseGoogleVerifierOptions = {}) {
    this.clientId = clientId;
    this.keys = options.keys ?? GOOGLE_KEYS;
  }

  async verify(credential: string): Promise<GoogleClaims> {
    if (!this.clientId) throw new AppError(503, MESSAGES.googleNotSetUp);
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(credential, this.keys, {
        audience: this.clientId,
        issuer: GOOGLE_ISSUERS,
        // Google signs with RS256, and a token with no expiry or subject is not one of theirs.
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'sub'],
      }));
    } catch {
      throw new AppError(401, MESSAGES.googleFailed);
    }
    return claimsOf(payload);
  }
}

import { createRemoteJWKSet, errors, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';
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

/**
 * Google could not be asked: its signing keys could not be fetched (timeout, network error,
 * a bad answer), so we cannot say whether the credential is good. That is our side's problem, not
 * the caller's, so it is a 503 with its own sentence; `cause` holds what really went wrong, for
 * the log (the response never carries it). Not a verdict on the credential: a person who gets
 * this should simply try again.
 */
export class GoogleUnavailableError extends AppError {
  constructor(cause: unknown) {
    super(503, MESSAGES.googleUnavailable);
    this.name = 'GoogleUnavailableError';
    this.cause = cause;
  }
}

/**
 * What jose throws when the TOKEN is at fault: bad signature, expired, wrong audience or issuer,
 * malformed, no key of that id in Google's set, a signing algorithm we do not accept. These are
 * 401s. Everything else that can come out of `jwtVerify` is about getting Google's keys (a
 * timeout, a network error, an answer that is not a key set) and means we cannot tell.
 */
const BAD_CREDENTIAL: readonly (new (...args: never[]) => Error)[] = [
  errors.JWTClaimValidationFailed,
  errors.JWTExpired,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
];

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
 * not expired.
 * - A credential that is wrong in any way is the same 401 with the same plain sentence.
 * - Failing to get Google's keys is a GoogleUnavailableError (503), never a 401.
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
    } catch (err) {
      if (BAD_CREDENTIAL.some((fault) => err instanceof fault)) throw new AppError(401, MESSAGES.googleFailed);
      throw new GoogleUnavailableError(err);
    }
    return claimsOf(payload);
  }
}

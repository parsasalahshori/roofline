/*
 * Google's photos (the roof's true-ortho photo, Street View photos of the front) are kept only for the days Google's
 * terms allow (docs/compliance/google-data-retention.md); after that the server answers 410 Gone. An <img> or a map
 * image source cannot see the status, so on a load error this asks once (HEAD, no bytes) to tell "expired" from any
 * other failure.
 */

export type PhotoFailure = 'expired' | 'failed';

/** Why `src` did not load: 'expired' when the server says 410 (Google's limit), else 'failed'. Never throws. */
export async function googlePhotoFailure(src: string, doFetch: typeof fetch = (input, init) => fetch(input, init)): Promise<PhotoFailure> {
  try {
    const res = await doFetch(src, { method: 'HEAD', credentials: 'same-origin' });
    return res.status === 410 ? 'expired' : 'failed';
  } catch {
    return 'failed';
  }
}

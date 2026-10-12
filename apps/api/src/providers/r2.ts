import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import type { Config } from '../config.ts';
import type { ObjectStore } from './object-store.ts';

export interface R2Options {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  fetch?: typeof fetch;
}

/** Plain message plus the numeric status only; provider response text is never read into an error. */
function unavailable(status: number): Error {
  return new Error(`File storage isn't available right now (status ${status}).`);
}

/**
 * Cloudflare R2 over its S3 API, signed with SigV4. The bucket is private: no public URL is ever
 * built; the only link that leaves the server is `signedGetUrl`'s short-lived presigned GET (D1's
 * call-recording playback, Ruling DV).
 */
export class R2ObjectStore implements ObjectStore {
  readonly configured = true;
  private readonly client: AwsClient;
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(o: R2Options) {
    this.client = new AwsClient({
      accessKeyId: o.accessKeyId,
      secretAccessKey: o.secretAccessKey,
      service: 's3',
      region: 'auto',
    });
    this.base = `https://${o.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(o.bucket)}`;
    this.doFetch = o.fetch ?? ((input, init) => fetch(input, init));
  }

  private url(key: string): string {
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const signed = await this.client.sign(this.url(key), {
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'x-amz-content-sha256': hash },
      // The DOM BodyInit wants an ArrayBuffer-backed view; the bytes are one, typed more loosely.
      body: bytes as RequestInit['body'],
    });
    const res = await this.doFetch(signed);
    if (!res.ok) throw unavailable(res.status);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const signed = await this.client.sign(this.url(key), { method: 'GET' });
    const res = await this.doFetch(signed);
    if (res.status === 404) return null;
    if (!res.ok) throw unavailable(res.status);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** A presigned GET that stops working after `seconds` (D1 Ruling DV: recording playback). */
  async signedGetUrl(key: string, seconds: number): Promise<string> {
    const url = new URL(this.url(key));
    url.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.floor(seconds))));
    const signed = await this.client.sign(url.toString(), { method: 'GET', aws: { signQuery: true } });
    return signed.url;
  }

  /** Removes one object; a missing key is not an error (D1 Ruling DV: the retention sweep). */
  async delete(key: string): Promise<void> {
    const signed = await this.client.sign(this.url(key), { method: 'DELETE' });
    const res = await this.doFetch(signed);
    if (res.status === 404) return;
    if (!res.ok) throw unavailable(res.status);
  }
}

export function r2For(config: Config): ObjectStore | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = config;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null;
  return new R2ObjectStore({
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    bucket: R2_BUCKET,
  });
}

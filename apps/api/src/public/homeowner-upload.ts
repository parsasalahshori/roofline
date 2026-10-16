import type { Readable } from 'node:stream';

/*
 * Receiving a photo from the homeowner's phone. The API is signed out and a token costs nothing (POST /requests), so
 * what a photo may use is bounded here: a photo is held in memory from its first byte until it is stored, and each one
 * is up to 12 MB, so only so many are taken at once (per request, per IP address, and in this process), and one that
 * stops arriving, or takes far too long, is cut off. A refused photo is a 429 before any byte is read; nothing is stored.
 */

/** The bounds on photos being received (the app uploads a few at a time; a stall is a dead connection or an attack). */
export const UPLOAD_GUARD = {
  /** At once for one request (token). */
  perRequest: 3,
  /** At once from one IP address (a household or a mobile carrier's shared address may have several people). */
  perIp: 6,
  /** At once in this API process, whoever they are from. */
  inProcess: 12,
  /** A photo that sends nothing for this long is cut off. */
  idleMs: 20_000,
  /** A photo that has not arrived whole after this long is cut off (12 MB in 3 minutes is 0.5 Mbit/s). */
  totalMs: 180_000,
  /** What a refused caller is told to wait, seconds. */
  retryAfterSeconds: 3,
} as const;

export type UploadPlace = {
  /** Gives the place back. Safe to call more than once. */
  leave(): void;
};

const bump = (counts: Map<string, number>, key: string, by: 1 | -1): void => {
  const next = (counts.get(key) ?? 0) + by;
  if (next <= 0) counts.delete(key);
  else counts.set(key, next);
};

/** Counts the photos being received, per request, per IP address and in all, and says no past the bounds. */
export class UploadGate {
  private total = 0;
  private readonly requests = new Map<string, number>();
  private readonly ips = new Map<string, number>();

  constructor(private readonly max: { perRequest: number; perIp: number; inProcess: number } = UPLOAD_GUARD) {}

  /** A place for one more photo from this request and address, or null when one of the three bounds is reached. */
  enter(request: string, ip: string): UploadPlace | null {
    if (this.total >= this.max.inProcess || (this.requests.get(request) ?? 0) >= this.max.perRequest || (this.ips.get(ip) ?? 0) >= this.max.perIp) return null;
    this.total += 1;
    bump(this.requests, request, 1);
    bump(this.ips, ip, 1);
    let left = false;
    return {
      leave: () => {
        if (left) return;
        left = true;
        this.total -= 1;
        bump(this.requests, request, -1);
        bump(this.ips, ip, -1);
      },
    };
  }

  /** Photos being received right now (for tests). */
  get inFlight(): number {
    return this.total;
  }
}

/** The part of an incoming request the guard needs. */
export type UploadStream = Pick<Readable, 'on' | 'off' | 'destroy'>;

const ignore = (): void => undefined;

/**
 * Starts the clock on a photo being received: the request is destroyed when no byte arrives for `idleMs`, or when it is not
 * whole after `totalMs` (the reader then fails and the connection is gone). Call it just before the body is read, and
 * the returned function once the body has been read or has failed.
 */
export function guardUpload(req: UploadStream, idleMs: number = UPLOAD_GUARD.idleMs, totalMs: number = UPLOAD_GUARD.totalMs): () => void {
  const cut = () => req.destroy(new Error('The photo stopped arriving.'));
  const idle = setTimeout(cut, idleMs);
  const total = setTimeout(cut, totalMs);
  idle.unref();
  total.unref();
  const alive = () => {
    idle.refresh();
  };
  req.on('data', alive);
  // Destroying a request with an error emits 'error'; with nobody listening that would be an uncaught exception.
  req.on('error', ignore);
  return () => {
    clearTimeout(idle);
    clearTimeout(total);
    req.off('data', alive);
  };
}

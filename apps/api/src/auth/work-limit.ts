import { AppError } from '../errors.ts';

/** What a caller is told when the queue for slow work is full. */
export const BUSY_MESSAGE = "We're very busy right now. Please try again in a few seconds.";
/** The `Retry-After` (seconds) sent with that 503. */
export const BUSY_RETRY_AFTER_SECONDS = 5;

/** The queue for slow work was full: a 503 with BUSY_MESSAGE. The auth router adds `Retry-After`. */
export class BusyError extends AppError {
  constructor() {
    super(503, BUSY_MESSAGE);
    this.name = 'BusyError';
  }
}

/**
 * A counting semaphore with a bounded queue: at most `maxActive` jobs run at once, at most
 * `maxQueued` more wait (first come, first served), and anything beyond that is refused at once with
 * a BusyError instead of piling up. A slot is handed straight to the next waiter when a job ends,
 * whether it succeeded or threw.
 */
export class WorkLimiter {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly maxActive: number;
  private readonly maxQueued: number;

  constructor(maxActive: number, maxQueued: number) {
    this.maxActive = maxActive;
    this.maxQueued = maxQueued;
    if (!Number.isInteger(maxActive) || maxActive < 1) throw new Error('maxActive must be a whole number of at least 1');
    if (!Number.isInteger(maxQueued) || maxQueued < 0) throw new Error('maxQueued must be a whole number of at least 0');
  }

  /** Jobs running now. */
  get active(): number {
    return this.running;
  }

  /** Jobs waiting for a slot. */
  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running < this.maxActive) {
      this.running += 1;
    } else {
      if (this.waiting.length >= this.maxQueued) throw new BusyError();
      // The slot is handed over by `release`, so `running` already counts this job when it resumes.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }
}

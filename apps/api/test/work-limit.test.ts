import { describe, expect, test } from 'vitest';
import { hashPassword, passwordWork, SCRYPT_MAX_ACTIVE, SCRYPT_MAX_QUEUED, verifyPassword } from '../src/auth/password.ts';
import { BUSY_MESSAGE, BusyError, WorkLimiter } from '../src/auth/work-limit.ts';

/** A job the test finishes by hand. */
function gate() {
  let open!: () => void;
  let fail!: (err: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { done, open, fail };
}

/** Lets every pending promise callback run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('WorkLimiter', () => {
  test('runs at most maxActive jobs at once; the rest wait in order', async () => {
    const limiter = new WorkLimiter(2, 5);
    const gates = [gate(), gate(), gate(), gate()];
    const started: number[] = [];
    const runs = gates.map((g, i) =>
      limiter.run(async () => {
        started.push(i);
        await g.done;
        return i;
      }),
    );
    await flush();
    expect(started).toEqual([0, 1]);
    expect(limiter.active).toBe(2);
    expect(limiter.queued).toBe(2);

    gates[1]!.open();
    await flush();
    expect(started).toEqual([0, 1, 2]);
    expect(limiter.active).toBe(2);

    gates[0]!.open();
    gates[2]!.open();
    gates[3]!.open();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(limiter.active).toBe(0);
    expect(limiter.queued).toBe(0);
  });

  test('a full queue is refused at once with a 503 BusyError, and nothing extra runs', async () => {
    const limiter = new WorkLimiter(1, 1);
    const g = gate();
    const first = limiter.run(() => g.done);
    const second = limiter.run(() => g.done);
    let ran = false;
    const refused = limiter.run(async () => {
      ran = true;
    });
    await expect(refused).rejects.toBeInstanceOf(BusyError);
    await expect(refused).rejects.toMatchObject({ status: 503, message: BUSY_MESSAGE });
    expect(ran).toBe(false);
    g.open();
    await Promise.all([first, second]);
    // With room again, work is taken.
    expect(await limiter.run(async () => 'ok')).toBe('ok');
  });

  test('a job that throws still gives its slot back', async () => {
    const limiter = new WorkLimiter(1, 0);
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(limiter.active).toBe(0);
    expect(await limiter.run(async () => 1)).toBe(1);
  });

  test('refuses nonsense sizes', () => {
    expect(() => new WorkLimiter(0, 1)).toThrow();
    expect(() => new WorkLimiter(1, -1)).toThrow();
    expect(() => new WorkLimiter(1.5, 1)).toThrow();
  });
});

describe('password hashing goes through one shared gate', () => {
  test('the gate is small, and a full gate refuses a hash and a check with BusyError', async () => {
    expect(SCRYPT_MAX_ACTIVE).toBeLessThanOrEqual(4);
    const g = gate();
    const holders = Array.from({ length: SCRYPT_MAX_ACTIVE + SCRYPT_MAX_QUEUED }, () => passwordWork.run(() => g.done));
    await flush();
    expect(passwordWork.active).toBe(SCRYPT_MAX_ACTIVE);
    expect(passwordWork.queued).toBe(SCRYPT_MAX_QUEUED);

    await expect(hashPassword('a long enough password')).rejects.toBeInstanceOf(BusyError);
    const stored = 'scrypt$16384$8$1$' + Buffer.alloc(16, 1).toString('base64') + '$' + Buffer.alloc(64, 2).toString('base64');
    await expect(verifyPassword('a long enough password', stored)).rejects.toBeInstanceOf(BusyError);

    g.open();
    await Promise.all(holders);
    expect(passwordWork.active).toBe(0);
    const hash = await hashPassword('a long enough password');
    expect(await verifyPassword('a long enough password', hash)).toBe(true);
  });
});

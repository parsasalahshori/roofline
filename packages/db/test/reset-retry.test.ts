import { describe, expect, test, vi } from 'vitest';
import { truncateWithRetry } from '../src/testing/reset.ts';

/** A pg client stand-in whose query fails with the given errors in order, then succeeds. */
function clientFailing(...errors: unknown[]) {
  const query = vi.fn(async () => {
    const next = errors.shift();
    if (next !== undefined) throw next;
    return { rows: [] };
  });
  return { query } as unknown as Parameters<typeof truncateWithRetry>[0] & { query: typeof query };
}

const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });

describe('truncateWithRetry', () => {
  test('retries a deadlock victim and then succeeds', async () => {
    vi.useFakeTimers();
    try {
      const client = clientFailing(deadlock(), deadlock());
      const done = truncateWithRetry(client, 'truncate table x');
      await vi.runAllTimersAsync();
      await done;
      expect(client.query).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('gives up after 5 attempts and throws the deadlock', async () => {
    vi.useFakeTimers();
    try {
      const client = clientFailing(deadlock(), deadlock(), deadlock(), deadlock(), deadlock());
      const done = truncateWithRetry(client, 'truncate table x');
      const caught = done.catch((err: unknown) => err);
      await vi.runAllTimersAsync();
      expect(await caught).toMatchObject({ code: '40P01' });
      expect(client.query).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  test('any other error is thrown at once', async () => {
    const client = clientFailing(Object.assign(new Error('permission denied'), { code: '42501' }));
    await expect(truncateWithRetry(client, 'truncate table x')).rejects.toMatchObject({ code: '42501' });
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});

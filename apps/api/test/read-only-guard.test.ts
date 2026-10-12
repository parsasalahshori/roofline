import { describe, expect, test, vi } from 'vitest';
import { READ_ONLY_MESSAGE, readOnlyGuard } from '../src/billing/read-only.ts';

type Status = 'trial_ended' | 'canceled' | 'active';

/** Runs the guard for one request. Plain objects only: no app, no database. */
function run(method: string, path: string, companyStatus: Status | null) {
  const next = vi.fn();
  const recorded: { code?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      recorded.code = code;
      return res;
    },
    json(body: unknown) {
      recorded.body = body;
      return res;
    },
  };
  const req = {
    method,
    path,
    session: companyStatus === null ? undefined : { companyStatus },
  };
  readOnlyGuard(req as never, res as never, next);
  return { next, recorded };
}

describe('read-only guard', () => {
  test.each([['POST', '/billing'], ['POST', '/me'], ['POST', '/auth/logout'], ['POST', '/billing/checkout'], ['PATCH', '/me/today']])(
    'a trial that has ended can still %s %s',
    (method, path) => {
      const { next, recorded } = run(method, path, 'trial_ended');
      expect(next).toHaveBeenCalledTimes(1);
      expect(recorded.code).toBeUndefined();
    },
  );

  test('the bare paths are open, and so is a canceled plan on the billing page', () => {
    const { next } = run('POST', '/billing', 'canceled');
    expect(next).toHaveBeenCalledTimes(1);
  });

  test.each([['POST', '/billingx'], ['POST', '/merge'], ['POST', '/customers'], ['PATCH', '/authz']])(
    'a trial that has ended is refused on %s %s with the read-only message',
    (method, path) => {
      const { next, recorded } = run(method, path, 'trial_ended');
      expect(next).not.toHaveBeenCalled();
      expect(recorded.code).toBe(403);
      expect(recorded.body).toEqual({ error: READ_ONLY_MESSAGE.trial_ended });
    },
  );

  test('a read is always let through, even for a trial that has ended', () => {
    const { next, recorded } = run('GET', '/customers', 'trial_ended');
    expect(next).toHaveBeenCalledTimes(1);
    expect(recorded.code).toBeUndefined();
  });

  test('a request without a session passes', () => {
    const { next } = run('POST', '/customers', null);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('an active company can write', () => {
    const { next } = run('POST', '/customers', 'active');
    expect(next).toHaveBeenCalledTimes(1);
  });
});

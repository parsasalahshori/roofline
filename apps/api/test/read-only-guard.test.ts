import { describe, expect, test, vi } from 'vitest';
import { READ_ONLY_MESSAGE, readOnlyGuard } from '../src/billing/read-only.ts';

type Status = 'trial_ended' | 'canceled' | 'active';

/** Runs the guard for one request. Plain objects only: no app, no database. */
function run(method: string, path: string, companyStatus: Status | null, body?: unknown) {
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
    body,
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

  test.each([
    ['POST', '/billingx'],
    ['POST', '/merge'],
    ['POST', '/customers'],
    ['PATCH', '/authz'],
    ['PUT', '/me/transfer-phone'],
    ['PUT', '/me/Transfer-Phone/'],
  ])(
    'a trial that has ended is refused on %s %s with the read-only message',
    (method, path) => {
      const { next, recorded } = run(method, path, 'trial_ended');
      expect(next).not.toHaveBeenCalled();
      expect(recorded.code).toBe(403);
      expect(recorded.body).toEqual({ error: READ_ONLY_MESSAGE.trial_ended });
    },
  );

  test('a read-only company may turn Front Desk off, and nothing else on that path (Ruling BG)', () => {
    for (const status of ['trial_ended', 'canceled'] as const) {
      expect(run('PUT', '/front-desk/settings', status, { enabled: false, texts: true }).next).toHaveBeenCalledTimes(1);
    }
    for (const [method, body] of [
      ['PUT', { enabled: true }],
      ['PUT', { enabled: 'false' }],
      ['PUT', {}],
      ['PUT', undefined],
      ['POST', { enabled: false }],
    ] as const) {
      const { next, recorded } = run(method, '/front-desk/settings', 'trial_ended', body);
      expect(next).not.toHaveBeenCalled();
      expect(recorded.code).toBe(403);
    }
    const other = run('POST', '/front-desk/forwarding-test', 'trial_ended', { enabled: false });
    expect(other.recorded.code).toBe(403);
  });

  test('a read is always let through, even for a trial that has ended', () => {
    const { next, recorded } = run('GET', '/customers', 'trial_ended');
    expect(next).toHaveBeenCalledTimes(1);
    expect(recorded.code).toBeUndefined();
  });

  test.each([['POST', '/public/proposals/x/sign'], ['DELETE', '/PUBLIC/x'], ['PATCH', '/public/x']])(
    'a trial that has ended does not block %s %s under /public/',
    (method, path) => {
      const { next, recorded } = run(method, path, 'trial_ended');
      expect(next).toHaveBeenCalledTimes(1);
      expect(recorded.code).toBeUndefined();
    },
  );

  test.each([['POST', '/publicx/x'], ['POST', '/public'], ['POST', '/proposals'], ['POST', '/estimator/settings']])(
    'writes elsewhere are still blocked: %s %s',
    (method, path) => {
      const { next, recorded } = run(method, path, 'canceled');
      expect(next).not.toHaveBeenCalled();
      expect(recorded.code).toBe(403);
    },
  );

  test('a request without a session passes', () => {
    const { next } = run('POST', '/customers', null);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('an active company can write', () => {
    const { next } = run('POST', '/customers', 'active');
    expect(next).toHaveBeenCalledTimes(1);
  });

  describe('Front Desk settings: turning it off stays open', () => {
    test.each(['trial_ended', 'canceled'] as const)('PUT /front-desk/settings with enabled false is allowed for %s', (status) => {
      const { next, recorded } = run('PUT', '/front-desk/settings', status, { enabled: false });
      expect(next).toHaveBeenCalledTimes(1);
      expect(recorded.code).toBeUndefined();
    });

    test('the path is case-insensitive and may end in a slash', () => {
      expect(run('PUT', '/Front-Desk/Settings/', 'trial_ended', { enabled: false }).next).toHaveBeenCalledTimes(1);
    });

    test.each([[{ enabled: true }], [undefined], [{}], [{ enabled: 'false' }]])('turning it on (%j) gets the read-only message', (body) => {
      const { next, recorded } = run('PUT', '/front-desk/settings', 'trial_ended', body);
      expect(next).not.toHaveBeenCalled();
      expect(recorded.code).toBe(403);
      expect(recorded.body).toEqual({ error: READ_ONLY_MESSAGE.trial_ended });
    });

    test('another PUT path and another method are refused', () => {
      for (const [method, path] of [['PUT', '/front-desk/other'], ['POST', '/front-desk/settings']] as const) {
        const { next, recorded } = run(method, path, 'canceled', { enabled: false });
        expect(next).not.toHaveBeenCalled();
        expect(recorded.code).toBe(403);
        expect(recorded.body).toEqual({ error: READ_ONLY_MESSAGE.canceled });
      }
    });
  });
});

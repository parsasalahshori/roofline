import { inspect } from 'node:util';
import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { users } from '@roofline/db';
import { type AppOptions, createApp } from '../src/app.ts';
import { AppError, describeErrorForLog } from '../src/errors.ts';
import { parse } from '../src/validate.ts';
import { loginAs, makeTestApp, type TestApp } from './helpers.ts';

const APP_ORIGIN = 'https://app.roofline.test';
const GENERIC_500 = 'Something went wrong on our side. Please try again.';

let t: TestApp;

beforeAll(async () => {
  t = await makeTestApp();
});

/** The same dependencies as `t`, with a few test-only routes and an error logger spy. */
function appWith(extraRoutes: AppOptions['extraRoutes'], configOverrides: Partial<TestApp['deps']['config']> = {}) {
  const logError = vi.fn();
  const app = createApp({ ...t.deps, config: { ...t.deps.config, ...configOverrides } }, { extraRoutes, logError });
  return { app, logError };
}

describe('health and not found', () => {
  test('GET /health → 200 {ok: true}', async () => {
    const res = await request(t.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('GET /api/nope → 404 in plain English (for a signed-in user; signed out it is the sign-in 401)', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    const res = await agent.get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "We couldn't find that." });
    const signedOut = await request(t.app).get('/api/nope');
    expect(signedOut.status).toBe(401);
    expect(signedOut.body).toEqual({ error: 'Please sign in.' });
  });

  test('a path outside /api is a plain 404 for anyone', async () => {
    const res = await request(t.app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "We couldn't find that." });
  });

  test('an unknown POST from the app itself is a JSON 404, not an HTML page', async () => {
    const agent = await loginAs(t.app, t.seed.a.owner);
    const res = await agent.post('/api/nope').set('Origin', APP_ORIGIN).send({});
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "We couldn't find that." });
  });
});

describe('cross-site mutations', () => {
  const BLOCKED = { error: 'This request came from another site and was blocked.' };

  test('POST /api/anything with Origin https://evil.example → 403', async () => {
    const res = await request(t.app).post('/api/anything').set('Origin', 'https://evil.example').send({});
    expect(res.status).toBe(403);
    expect(res.body).toEqual(BLOCKED);
  });

  test.each(['post', 'put', 'patch', 'delete'] as const)('%s with a foreign Origin → 403', async (method) => {
    const res = await request(t.app)[method]('/api/anything').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body).toEqual(BLOCKED);
  });

  test.each([
    ['a look-alike host', 'https://app.roofline.test.evil.example'],
    ['the wrong scheme', 'http://app.roofline.test'],
    ['the wrong port', 'https://app.roofline.test:8443'],
    ['a sandboxed page', 'null'],
  ])('%s is blocked', async (_name, origin) => {
    const res = await request(t.app).post('/api/anything').set('Origin', origin).send({});
    expect(res.status).toBe(403);
    expect(res.body).toEqual(BLOCKED);
  });

  test('the check runs before the body is read', async () => {
    const res = await request(t.app)
      .post('/api/anything')
      .set('Origin', 'https://evil.example')
      .send({ data: 'x'.repeat(300 * 1024) });
    expect(res.status).toBe(403);
  });

  // "Allowed" means past the origin check: a signed-out request then meets the sign-in gate (401).
  test('APP_ORIGIN itself is allowed', async () => {
    const res = await request(t.app).post('/api/anything').set('Origin', APP_ORIGIN).send({});
    expect(res.status).toBe(401);
  });

  test('a request with no Origin (a script, or the Twilio webhook) is allowed', async () => {
    const res = await request(t.app).post('/api/anything').send({});
    expect(res.status).toBe(401);
    expect((await request(t.app).post('/hooks/anything').send({})).status).toBe(404);
  });

  test('reads are not mutations, so a foreign Origin on a GET is allowed', async () => {
    const res = await request(t.app).get('/api/anything').set('Origin', 'https://evil.example');
    expect(res.status).toBe(401);
  });
});

describe('body limits and parsing', () => {
  test('a 300 KB JSON body → 413 in plain English', async () => {
    const res = await request(t.app)
      .post('/api/anything')
      .set('Origin', APP_ORIGIN)
      .send({ data: 'x'.repeat(300 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'That request was too large.' });
  });

  test('a 200 KB JSON body is within the limit and is parsed', async () => {
    const { app } = appWith((a) => {
      a.post('/api/echo-size', (req, res) => {
        res.json({ length: (req.body as { data: string }).data.length });
      });
    });
    const res = await request(app).post('/api/echo-size').send({ data: 'x'.repeat(200 * 1024) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ length: 200 * 1024 });
  });

  test('malformed JSON → 400 in plain English, with no parser detail', async () => {
    const res = await request(t.app)
      .post('/api/anything')
      .set('Origin', APP_ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{"a": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "We couldn't read that request. Please check it and try again." });
  });

  test('form bodies are not parsed globally (urlencoded is for /hooks/twilio/* only)', async () => {
    const { app } = appWith((a) => {
      a.post('/api/echo-body', (req, res) => {
        res.json({ body: (req.body as unknown) ?? null });
      });
    });
    const form = await request(app).post('/api/echo-body').type('form').send({ a: '1' });
    expect(form.body).toEqual({ body: null });
    const json = await request(app).post('/api/echo-body').send({ a: '1' });
    expect(json.body).toEqual({ body: { a: '1' } });
  });
});

describe('error responses', () => {
  test('a thrown plain Error → 500 with the generic message, no stack, nothing from the error', async () => {
    const boom = new Error('connection string postgres://roofline:hunter2@db/prod refused');
    const { app, logError } = appWith((a) => {
      a.get('/api/boom', () => {
        throw boom;
      });
    });
    const res = await request(app).get('/api/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: GENERIC_500 });
    expect(res.body).not.toHaveProperty('stack');
    expect(res.text).not.toMatch(/hunter2|postgres:|\bat .*\.ts/);
    // The detail stays on the server.
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]?.[0]).toBe(boom);
  });

  test('an async handler that rejects → the same 500', async () => {
    const { app } = appWith((a) => {
      a.get('/api/boom-async', async () => {
        await Promise.resolve();
        throw new Error('late failure');
      });
    });
    const res = await request(app).get('/api/boom-async');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: GENERIC_500 });
  });

  test('a Drizzle-wrapped Postgres error does not leak its cause', async () => {
    // Drizzle wraps the driver error: the message is the failed SQL, and the pg error (with its
    // `code` and `detail`) is on `cause`.
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
      code: '23505',
      detail: 'Key (email)=(owner@a.test) already exists.',
      constraint: 'users_email_key',
    });
    const wrapped = new Error('Failed query: insert into "users" ("email") values ($1)', { cause: pgError });
    const { app, logError } = appWith((a) => {
      a.post('/api/dup', () => {
        throw wrapped;
      });
    });
    const res = await request(app).post('/api/dup').send({});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: GENERIC_500 });
    expect(res.text).not.toMatch(/23505|owner@a\.test|users_email_key|insert into/);
    expect(logError.mock.calls[0]?.[0]).toBe(wrapped);
  });

  describe('the default error log (R14: never SQL parameters)', () => {
    const HASH = 'scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2hoYQ==';

    /** Everything the default logger printed, flattened to one string. */
    async function logFor(thrown: unknown): Promise<string[]> {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const app = createApp(t.deps, {
          extraRoutes: (a) => {
            a.get('/api/log-me', async () => {
              await Promise.resolve();
              throw thrown;
            });
          },
        }); // no logError option: this is the default logger
        const res = await request(app).get('/api/log-me');
        expect(res.status).toBe(500);
        return spy.mock.calls.map((call) => call.map((arg) => (typeof arg === 'string' ? arg : inspect(arg))).join(' '));
      } finally {
        spy.mockRestore();
      }
    }

    test('a Drizzle-style error with `params: <hash>` logs its name, first line and pg code, and no hash', async () => {
      const pgError = Object.assign(new Error('duplicate key value violates unique constraint "users_email_unique"'), {
        code: '23505',
        detail: 'Key (email)=(owner@a.test) already exists.',
      });
      const wrapped = new Error(`Failed query: insert into "users" ("email", "password_hash") values ($1, $2)\nparams: owner@a.test,${HASH}`, {
        cause: pgError,
      });
      wrapped.name = 'DrizzleQueryError';
      const lines = await logFor(wrapped);
      expect(lines).toEqual([
        'Unhandled error on /api/log-me: DrizzleQueryError: Failed query: insert into "users" ("email", "password_hash") values ($1, $2) (pg 23505)',
      ]);
      const printed = lines.join('\n');
      expect(printed).not.toContain(HASH);
      expect(printed).not.toMatch(/scrypt|params|owner@a\.test|aGFzaGhh/);
    });

    test('a real failed Drizzle insert (duplicate email) logs no password hash either', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const app = createApp(t.deps, {
          extraRoutes: (a) => {
            a.get('/api/real-dup', async () => {
              await t.deps.pools.system
                .insert(users)
                .values({ email: t.seed.a.owner.email, name: 'Dup', passwordHash: HASH });
            });
          },
        });
        const res = await request(app).get('/api/real-dup');
        expect(res.status).toBe(500);
        const printed = spy.mock.calls.map((call) => call.map((arg) => (typeof arg === 'string' ? arg : inspect(arg))).join(' ')).join('\n');
        expect(printed).toContain('(pg 23505)');
        expect(printed).toContain('Failed query');
        expect(printed).not.toContain(HASH);
        expect(printed).not.toContain(t.seed.a.owner.email);
        expect(printed).not.toMatch(/params|scrypt/);
      } finally {
        spy.mockRestore();
      }
    });

    test('a plain Error logs its name and first line only, with no stack', async () => {
      const lines = await logFor(new TypeError('Cannot read properties of undefined\n    at secret (/srv/app/file.ts:1:1)'));
      expect(lines).toEqual(['Unhandled error on /api/log-me: TypeError: Cannot read properties of undefined']);
    });

    test('something that is not an Error is not printed at all', async () => {
      const lines = await logFor({ password: 'hunter2', hash: HASH });
      expect(lines).toEqual(['Unhandled error on /api/log-me: A non-Error value was thrown.']);
    });

    test('describeErrorForLog cuts `params:` wherever it starts', () => {
      expect(describeErrorForLog(new Error('select 1 params: a,b'))).toBe('Error: select 1');
      expect(describeErrorForLog(new Error('select 1\r\nparams: a,b'))).toBe('Error: select 1');
      expect(describeErrorForLog(new Error('first\nsecond'))).toBe('Error: first');
      expect(describeErrorForLog(Object.assign(new Error('x'), { cause: { code: '23503' } }))).toBe('Error: x (pg 23503)');
      expect(describeErrorForLog(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } }))).toBe('Error: x');
    });
  });

  test('an error thrown with a status of its own is still a 500 unless it is an AppError', async () => {
    const { app } = appWith((a) => {
      a.get('/api/odd', () => {
        throw Object.assign(new Error('teapot'), { status: 418, statusCode: 418 });
      });
    });
    const res = await request(app).get('/api/odd');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: GENERIC_500 });
  });

  test('AppError → its status, message and field', async () => {
    const { app, logError } = appWith((a) => {
      a.get('/api/conflict', () => {
        throw new AppError(409, 'An account with that email already exists.', 'email');
      });
      a.get('/api/gone', () => {
        throw new AppError(410, 'That link has expired.');
      });
    });
    const withField = await request(app).get('/api/conflict');
    expect(withField.status).toBe(409);
    expect(withField.body).toEqual({ error: 'An account with that email already exists.', field: 'email' });
    const withoutField = await request(app).get('/api/gone');
    expect(withoutField.status).toBe(410);
    expect(withoutField.body).toEqual({ error: 'That link has expired.' });
    expect(Object.keys(withoutField.body)).toEqual(['error']);
    // Expected errors are not logged as failures.
    expect(logError).not.toHaveBeenCalled();
  });

  test('parse() failures → 400 with the field and the schema’s own message', async () => {
    const Body = z.object({
      email: z.email(),
      password: z.string().min(10, 'Use at least 10 characters.'),
    });
    const { app } = appWith((a) => {
      a.post('/api/signup-ish', (req, res) => {
        res.json(parse(Body, req.body));
      });
    });
    const short = await request(app).post('/api/signup-ish').send({ email: 'a@b.test', password: 'short' });
    expect(short.status).toBe(400);
    expect(short.body).toEqual({ error: 'Use at least 10 characters.', field: 'password' });
    const badEmail = await request(app).post('/api/signup-ish').send({ email: 'nope', password: 'long enough here' });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body).toEqual({ error: 'Please check this field.', field: 'email' });
    const noBody = await request(app).post('/api/signup-ish');
    expect(noBody.status).toBe(400);
    expect(noBody.body.error).not.toMatch(/expected|received|Invalid input/);
  });

  test('a raw ZodError that reaches the middleware is a 400 too, and never shows zod’s wording', async () => {
    const Body = z.object({ qty: z.number().min(1, 'Must be at least 1.') });
    const { app } = appWith((a) => {
      a.post('/api/raw-zod', (req, res) => {
        res.json(Body.parse(req.body));
      });
    });
    const res = await request(app).post('/api/raw-zod').send({ qty: 'lots' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Please check this field.', field: 'qty' });
  });
});

describe('security headers and proxy settings', () => {
  test('helmet’s defaults are on and x-powered-by is off', async () => {
    const res = await request(t.app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('TRUST_PROXY=0 ignores X-Forwarded-For; TRUST_PROXY=1 reads it', async () => {
    const routes: AppOptions['extraRoutes'] = (a) => {
      a.get('/api/ip', (req, res) => {
        res.json({ ip: req.ip });
      });
    };
    const direct = await request(appWith(routes, { TRUST_PROXY: 0 }).app)
      .get('/api/ip')
      .set('X-Forwarded-For', '203.0.113.9');
    expect(direct.body.ip).not.toBe('203.0.113.9');
    const behindProxy = await request(appWith(routes, { TRUST_PROXY: 1 }).app)
      .get('/api/ip')
      .set('X-Forwarded-For', '203.0.113.9');
    expect(behindProxy.body.ip).toBe('203.0.113.9');
  });
});

describe('makeTestApp', () => {
  test('resets and seeds two companies, and hands back the fakes', () => {
    const app: Express = t.app;
    expect(app).toBeTypeOf('function');
    expect(t.seed.a.companyId).not.toBe(t.seed.b.companyId);
    expect(t.seed.a.owner.email).toBe('owner@a.test');
    expect(t.mailer.sent).toEqual([]);
    expect(t.deps.clock).toBe(t.clock);
    expect(t.deps.mailer).toBe(t.mailer);
    const before = t.clock.now().getTime();
    t.clock.advance(1000);
    expect(t.clock.now().getTime()).toBe(before + 1000);
    t.clock.set(new Date('2026-01-02T03:04:05Z'));
    expect(t.clock.now().toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  test('the config overrides reach the app', async () => {
    const other = await makeTestApp({ APP_ORIGIN: 'https://other.roofline.test' });
    const res = await request(other.app).post('/api/anything').set('Origin', APP_ORIGIN).send({});
    expect(res.status).toBe(403);
  });
});

import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { errorHandler } from '../src/errors.ts';
import { LOGIN_LIMITS, type LoginLimits, loginRateLimit } from '../src/rate-limit.ts';

/*
 * The login limiters on a stand-in route (no database): the password "right" signs in (200),
 * "no-company" is the 403 of a right password with no access, and anything else is the 401 of a
 * wrong password or unknown email. The route itself is covered in auth-password.test.ts.
 */

const TOO_MANY = { error: 'Too many sign-in attempts. Try again in a few minutes.' };

function loginApp(limits: Partial<LoginLimits> = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.post('/login', ...loginRateLimit({ ...LOGIN_LIMITS, ...limits }), (req, res) => {
    const { password } = req.body as { password?: string };
    if (password === 'right') res.json({ ok: true });
    else if (password === 'no-company') res.status(403).json({ error: 'no access' });
    else res.status(401).json({ error: 'bad login' });
  });
  app.use(errorHandler(() => {}));
  return (email: string, password: string, ip = '203.0.113.1') =>
    request(app).post('/login').set('X-Forwarded-For', ip).send({ email, password });
}

describe('login limits', () => {
  test('the production numbers', () => {
    expect(LOGIN_LIMITS).toEqual({ perIpAndEmail: 10, perEmail: 20, perIp: 30, global: 2000 });
  });

  test('per email, across every address: the 21st failure in an hour is refused, even with the right password', async () => {
    const login = loginApp();
    for (let i = 1; i <= 20; i++) {
      expect((await login('owner@a.test', 'wrong', `198.51.100.${i}`)).status, `attempt ${i}`).toBe(401);
    }
    const blocked = await login('owner@a.test', 'right', '198.51.100.99');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(TOO_MANY);
    // Spelling variants share the lock; another email is untouched.
    expect((await login(' Owner@A.test ', 'right', '198.51.100.98')).status).toBe(429);
    expect((await login('office@a.test', 'right', '198.51.100.97')).status).toBe(200);
  });

  test('per email: an address with no account is locked exactly the same way (nothing to tell them apart)', async () => {
    const login = loginApp({ perEmail: 3 });
    for (let i = 1; i <= 3; i++) await login('nobody@a.test', 'wrong', `198.51.100.${i}`);
    const blocked = await login('nobody@a.test', 'wrong', '198.51.100.50');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(TOO_MANY);
  });

  test('per address, across every email: the 31st failure in 15 minutes is refused', async () => {
    const login = loginApp();
    for (let i = 1; i <= 30; i++) {
      expect((await login(`person${i}@a.test`, 'wrong')).status, `attempt ${i}`).toBe(401);
    }
    const blocked = await login('fresh@a.test', 'right');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(TOO_MANY);
    // Another address is untouched.
    expect((await login('fresh@a.test', 'right', '203.0.113.2')).status).toBe(200);
  });

  test('process-wide: once the failure budget is spent every login is refused', async () => {
    const login = loginApp({ global: 5 });
    for (let i = 1; i <= 5; i++) {
      expect((await login(`person${i}@a.test`, 'wrong', `198.51.100.${i}`)).status).toBe(401);
    }
    const blocked = await login('someone@a.test', 'right', '192.0.2.1');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(TOO_MANY);
  });

  test('only failures count: sign-ins, a right password without access, and bad input use up nothing', async () => {
    const login = loginApp({ perEmail: 2, perIp: 2, global: 2 });
    for (let i = 0; i < 5; i++) {
      expect((await login('owner@a.test', 'right')).status).toBe(200);
      expect((await login('owner@a.test', 'no-company')).status).toBe(403);
    }
    // Two failures are still allowed after all that.
    expect((await login('owner@a.test', 'wrong')).status).toBe(401);
    expect((await login('owner@a.test', 'wrong')).status).toBe(401);
    expect((await login('owner@a.test', 'right')).status).toBe(429);
  });

  test('refused attempts do not extend the per-address and per-email counts', async () => {
    const login = loginApp({ perEmail: 2 });
    await login('owner@a.test', 'wrong');
    await login('owner@a.test', 'wrong');
    for (let i = 0; i < 40; i++) expect((await login('owner@a.test', 'wrong')).status).toBe(429);
    // The per-address budget (30) was not used up by the 40 refusals.
    expect((await login('office@a.test', 'right')).status).toBe(200);
  });

  test('the original limit stays: 10 failures for one address + email', async () => {
    const login = loginApp();
    for (let i = 1; i <= 10; i++) expect((await login('owner@a.test', 'wrong')).status).toBe(401);
    expect((await login('owner@a.test', 'right')).status).toBe(429);
    expect((await login('owner@a.test', 'right', '203.0.113.9')).status).toBe(200);
  });
});

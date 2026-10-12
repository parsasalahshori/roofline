import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { isPublicRoute } from '../src/auth/middleware.ts';
import { MESSAGES } from '../src/errors.ts';
import { PUBLIC_RATE_LIMIT_PER_MIN } from '../src/rate-limit.ts';
import { builtInHandlers } from '../src/tasks/handlers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

describe('isPublicRoute', () => {
  test.each([
    ['GET', '/public/proposals/x', true],
    ['POST', '/public/x', true],
    ['DELETE', '/PUBLIC/x', true],
    ['GET', '/publicx', false],
    ['GET', '/public', false],
    ['GET', '/%70ublic/x', false],
    ['GET', '/customers', false],
    ['POST', '/auth/login', true],
    ['GET', '/auth/config', true],
  ])('%s %s -> %s', (method, path, expected) => {
    expect(isPublicRoute(method, path)).toBe(expected);
  });
});

describe('the estimator skeleton', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await makeTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  test('GET /api/public/proposals/x without a session is 404, not 401', async () => {
    const res = await request(t.app).get('/api/public/proposals/x');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "This proposal link doesn't work." });
  });

  test('POST /api/public/proposals/x/sign is not 401', async () => {
    const res = await request(t.app).post('/api/public/proposals/x/sign').send({});
    expect(res.status).not.toBe(401);
  });

  test('a session-only route (GET /api/customers) without a session is still 401', async () => {
    const res = await request(t.app).get('/api/customers');
    expect(res.status).toBe(401);
  });

  test('GET /api/PUBLIC/proposals/x is reachable too (case folded)', async () => {
    const res = await request(t.app).get('/api/PUBLIC/proposals/x');
    expect(res.status).not.toBe(401);
  });

  test('GET /api/publicx/proposals/x is 401', async () => {
    const res = await request(t.app).get('/api/publicx/proposals/x');
    expect(res.status).toBe(401);
  });

  test('GET /api/%70ublic/proposals/x is 401 (the path is not decoded)', async () => {
    const res = await request(t.app).get('/api/%70ublic/proposals/x');
    expect(res.status).toBe(401);
  });

  test('GET /api/public (no slash after) is 401', async () => {
    const res = await request(t.app).get('/api/public');
    expect(res.status).toBe(401);
  });

  test.each(['/api/measurements', '/api/tier-templates', '/api/estimator/settings', '/api/proposals'])(
    '%s requires a session',
    async (path) => {
      const res = await request(t.app).get(path);
      expect(res.status).toBe(401);
    },
  );

  test('public routes are rate limited per IP: the 61st request is 429', async () => {
    const agent = request.agent(t.app);
    for (let i = 0; i < PUBLIC_RATE_LIMIT_PER_MIN; i += 1) {
      const res = await agent.get('/api/public/proposals/x');
      expect(res.status).toBe(404);
    }
    const res = await agent.get('/api/public/proposals/x');
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: MESSAGES.tooFast });
  });

  test('tasks: builtInHandlers has send_proposal and order_exact_report', () => {
    expect(builtInHandlers.send_proposal).toBeDefined();
    expect(builtInHandlers.order_exact_report).toBeDefined();
  });

  test('the test app exposes the four seams', () => {
    expect(t.footprints).toBeDefined();
    expect(t.aerial).toBeDefined();
    expect(t.exactReports).toBeDefined();
    expect(t.objectStore).toBeDefined();
    expect(t.deps.footprints).toBe(t.footprints);
    expect(t.deps.aerial).toBe(t.aerial);
    expect(t.deps.exactReports).toBe(t.exactReports);
    expect(t.deps.objectStore).toBe(t.objectStore);
  });
});

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MESSAGES } from '../src/errors.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

describe('the storm skeleton', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await makeTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  test('the test app exposes the four storm seams', () => {
    expect(t.adsGoogle).toBeDefined();
    expect(t.adsMeta).toBeDefined();
    expect(t.broadcast).toBeDefined();
    expect(t.adImage).toBeDefined();
    expect(t.deps.adsGoogle).toBe(t.adsGoogle);
    expect(t.deps.adsMeta).toBe(t.adsMeta);
    expect(t.deps.broadcast).toBe(t.broadcast);
    expect(t.deps.adImage).toBe(t.adImage);
  });

  test.each(['/api/storms', '/api/routes', '/api/storm/settings', '/api/ads'])(
    'app routes for the storm mounts need a session: GET %s',
    async (path) => {
      const res = await request(t.app).get(path);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: MESSAGES.signIn });
    },
  );
});

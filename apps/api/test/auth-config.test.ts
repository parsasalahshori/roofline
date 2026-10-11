import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { makeTestApp, type TestApp } from './helpers.ts';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

describe('GET /api/auth/config', () => {
  test('answers without a session', async () => {
    const res = await request(t.app).get('/api/auth/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ googleClientId: 'roofline-test.apps.googleusercontent.com' });
  });

  test('gives null for the client id when Google sign-in is not set up', async () => {
    const other = await makeTestApp({ GOOGLE_CLIENT_ID: undefined });
    const res = await request(other.app).get('/api/auth/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ googleClientId: null });
  });
});

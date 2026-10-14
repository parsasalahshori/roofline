import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loginAs, makeTestApp } from './helpers.ts';

const INDEX_HTML = '<!doctype html><html><head><title>Roofline</title></head><body><div id="root"></div></body></html>\n';
const NOT_FOUND = { error: "We couldn't find that." };

let dist: string;

beforeAll(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'roofline-web-'));
  fs.writeFileSync(path.join(dist, 'index.html'), INDEX_HTML);
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'assets', 'app-123.js'), 'console.log("app");\n');
  fs.writeFileSync(path.join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});

afterAll(() => {
  fs.rmSync(dist, { recursive: true, force: true });
});

describe('serving the web app (WEB_DIST_DIR set)', () => {
  test.each(['/', '/approvals/abc', '/jobs/some/deep/path'])('GET %s sends index.html, uncached', async (url) => {
    const { app } = await makeTestApp({ WEB_DIST_DIR: dist });
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.text).toBe(INDEX_HTML);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  test.each(['/p/abcdefghijklmnopqrstuvwxyz012345', '/P/abcdefghijklmnopqrstuvwxyz012345'])(
    'the homeowner proposal page %s is noindex, no-store and no-referrer',
    async (url) => {
      const { app } = await makeTestApp({ WEB_DIST_DIR: dist });
      for (const res of [await request(app).get(url), await request(app).head(url)]) {
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/html/);
        expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['referrer-policy']).toBe('no-referrer');
      }
      // Other pages keep the revalidated no-cache and no robots header.
      const other = await request(app).get('/pricing');
      expect(other.headers['cache-control']).toBe('no-cache');
      expect(other.headers['x-robots-tag']).toBeUndefined();
    },
  );

  test('HEAD / is answered like GET, without a body', async () => {
    const { app } = await makeTestApp({ WEB_DIST_DIR: dist });
    const res = await request(app).head('/approvals/abc');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.text ?? '').toBe('');
  });

  test('GET /assets/app-123.js is served as immutable and cached for a year', async () => {
    const { app } = await makeTestApp({ WEB_DIST_DIR: dist });
    const res = await request(app).get('/assets/app-123.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.text).toBe('console.log("app");\n');
  });

  test('serves other built files too, without the immutable header', async () => {
    const { app } = await makeTestApp({ WEB_DIST_DIR: dist });
    const res = await request(app).get('/favicon.svg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/svg/);
    expect(res.headers['cache-control'] ?? '').not.toContain('immutable');
  });

  test('GET /assets/missing.js is a 404, not index.html', async () => {
    const { app } = await makeTestApp({ WEB_DIST_DIR: dist });
    const res = await request(app).get('/assets/missing.js');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<div id="root">');
  });

  test('a path that looks like a file is never answered with index.html', async () => {
    const { app } = await makeTestApp({ WEB_DIST_DIR: dist });
    for (const url of ['/nope.png', '/robots.txt', '/a/b/source.map']) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(404);
      expect(res.text, url).not.toContain('<div id="root">');
    }
  });

  test('index.html asked for by name is never cached either', async () => {
    const { app } = await makeTestApp({ WEB_DIST_DIR: dist });
    const res = await request(app).get('/index.html');
    expect(res.status).toBe(200);
    expect(res.text).toBe(INDEX_HTML);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  test('GET /api/nope is the API\'s JSON 404, never HTML', async () => {
    const { app } = await makeTestApp({ WEB_DIST_DIR: dist });
    const res = await request(app).get('/api/nope');
    // Signed out, the gate answers first with the JSON 401; signed in, the JSON 404 below.
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.text).not.toContain('<div id="root">');
  });

  test('a signed-in GET /api/nope is a 404 JSON { error }', async () => {
    const { app, seed } = await makeTestApp({ WEB_DIST_DIR: dist });
    const owner = await loginAs(app, seed.a.owner);
    const res = await owner.get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual(NOT_FOUND);
  });

  test('GET /hooks/anything stays the hooks\' JSON 404, and /health stays { ok: true }', async () => {
    const { app } = await makeTestApp({ WEB_DIST_DIR: dist });
    const hook = await request(app).get('/hooks/nope');
    expect(hook.status).toBe(404);
    expect(hook.headers['content-type']).toMatch(/json/);
    expect(hook.body).toEqual(NOT_FOUND);

    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true });
  });

  test('a POST to a page path is the JSON 404, not the page', async () => {
    const { app } = await makeTestApp({ WEB_DIST_DIR: dist });
    const res = await request(app).post('/approvals/abc').send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
  });

  test('lets the map and Google sign-in in and nothing else', async () => {
    const { app } = await makeTestApp({ WEB_DIST_DIR: dist });
    const res = await request(app).get('/');
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain('child-src blob:');
    expect(csp).toContain('https://api.maptiler.com');
    expect(csp).toContain('https://tile.openstreetmap.org');
    expect(csp).toContain('https://server.arcgisonline.com');
    expect(csp).toContain("img-src 'self' data: blob: https://api.maptiler.com https://tile.googleapis.com https://tile.openstreetmap.org https://server.arcgisonline.com");
    expect(csp).toContain("connect-src 'self' https://api.maptiler.com https://tile.googleapis.com https://tile.openstreetmap.org https://server.arcgisonline.com");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain('https://accounts.google.com/gsi/client');
    expect(csp).toContain('frame-src https://accounts.google.com/gsi/');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    // Plain http in development and the e2e stack: no upgrade to https unless NODE_ENV=production.
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  test('the content-security-policy asks browsers to upgrade to https in production only', async () => {
    const { app } = await makeTestApp({ WEB_DIST_DIR: dist, NODE_ENV: 'production' });
    const res = await request(app).get('/');
    expect(res.headers['content-security-policy']).toContain('upgrade-insecure-requests');
  });

  test("keeps helmet's other headers", async () => {
    const { app } = await makeTestApp({ WEB_DIST_DIR: dist });
    const res = await request(app).get('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('without WEB_DIST_DIR', () => {
  test('GET / is the JSON 404 and the CSP is still sent', async () => {
    const { app } = await makeTestApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual(NOT_FOUND);
    expect(res.headers['content-security-policy']).toContain("worker-src 'self' blob:");
  });
});

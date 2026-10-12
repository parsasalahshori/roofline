import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AdPlatformError, appSecretProof, createMetaHttp, mapMetaError } from '../src/providers/meta/http.ts';
import { fakeFetch, fixture, json } from './meta-helpers.ts';

/*
 * The Meta Graph HTTP client, against canned responses. Nothing here reaches the network: every test
 * hands the client its own `fetch`, so a test that forgot to would fail on a missing route, not call Meta.
 */

const BASE = 'https://graph.test';
const VERSION = 'v24.0';
const TOKEN = 'EAAB-test-system-user-token';
const SECRET = 'meta-app-secret-xyz';

const EXPECTED_PROOF = createHmac('sha256', SECRET).update(TOKEN).digest('hex');

function clientWith(answer: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(answer);
  const http = createMetaHttp({ appSecret: SECRET, token: TOKEN, version: VERSION, fetch: f.fetch, baseUrl: BASE });
  return { http, calls: f.calls };
}

type FixtureCase = { file: string; status: number; kind: string };

const ERROR_CASES: FixtureCase[] = [
  { file: 'error-token.json', status: 400, kind: 'access' },
  { file: 'error-special-category.json', status: 400, kind: 'targeting' },
  { file: 'error-policy.json', status: 400, kind: 'policy' },
  { file: 'error-payment.json', status: 400, kind: 'payment' },
  { file: 'error-rate-limit.json', status: 400, kind: 'other' },
  { file: 'error-unknown.json', status: 500, kind: 'other' },
];

/** The error a request throws when Meta answers with the named fixture. */
async function thrownBy(file: string, status: number): Promise<unknown> {
  const { http } = clientWith(() => json(fixture(file), status));
  return http.get('/act_1').then(
    () => {
      throw new Error('expected the request to fail');
    },
    (e: unknown) => e,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('appSecretProof', () => {
  test('is the lowercase hex HMAC-SHA256 keyed by the app secret over the token', () => {
    expect(appSecretProof(TOKEN, SECRET)).toBe(EXPECTED_PROOF);
    expect(appSecretProof(TOKEN, SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('matches the RFC 4231 HMAC-SHA256 test vector (key "Jefe")', () => {
    // RFC 4231 test case 2: key = "Jefe", data = "what do ya want for nothing?".
    expect(appSecretProof('what do ya want for nothing?', 'Jefe')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
});

describe('GET requests', () => {
  test('build the versioned URL and send access_token and appsecret_proof in the query string', async () => {
    const { http, calls } = clientWith(() => json({ name: 'Acme Roofing', currency: 'USD' }));

    const result = await http.get('/act_1', { fields: 'name,currency' });

    expect(result).toEqual({ name: 'Acme Roofing', currency: 'USD' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${BASE}/${VERSION}/act_1?fields=name,currency&access_token=${TOKEN}&appsecret_proof=${EXPECTED_PROOF}`,
    );
    expect(calls[0]?.init?.method ?? 'GET').toBe('GET');
  });

  test('accepts a path without a leading slash and no query', async () => {
    const { http, calls } = clientWith(() => json({ id: '1' }));

    await http.get('act_1');

    expect(calls[0]?.url).toBe(`${BASE}/${VERSION}/act_1?access_token=${TOKEN}&appsecret_proof=${EXPECTED_PROOF}`);
  });
});

describe('POST requests', () => {
  test('send access_token and appsecret_proof in a form-encoded body, JSON-stringifying non-string values', async () => {
    const { http, calls } = clientWith(() => json({ success: true }));

    await http.post('/act_1/assigned_users', { user: 'system-user-1', tasks: ['ADVERTISE', 'ANALYZE'], business: 123 });

    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/${VERSION}/act_1/assigned_users`);
    expect(call?.init?.method).toBe('POST');
    const body = call?.init?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    const form = body as URLSearchParams;
    expect(form.get('access_token')).toBe(TOKEN);
    expect(form.get('appsecret_proof')).toBe(EXPECTED_PROOF);
    expect(form.get('user')).toBe('system-user-1');
    expect(form.get('tasks')).toBe(JSON.stringify(['ADVERTISE', 'ANALYZE']));
    expect(form.get('business')).toBe('123');
  });

  test('append the token and proof to a FormData body and send it as is', async () => {
    const { http, calls } = clientWith(() => json({ hash: 'abc' }));
    const data = new FormData();
    data.append('filename', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'ad.png');

    await http.post('/act_1/adimages', data);

    const body = calls[0]?.init?.body;
    expect(body).toBe(data);
    expect(data.get('access_token')).toBe(TOKEN);
    expect(data.get('appsecret_proof')).toBe(EXPECTED_PROOF);
    expect(calls[0]?.url).toBe(`${BASE}/${VERSION}/act_1/adimages`);
  });
});

describe('error mapping', () => {
  test.each(ERROR_CASES)('$file maps to $kind and throws an AdPlatformError with the HTTP status', async ({ file, status, kind }) => {
    const error = await thrownBy(file, status);

    expect(error).toBeInstanceOf(AdPlatformError);
    expect((error as AdPlatformError).kind).toBe(kind);
    expect((error as AdPlatformError).status).toBe(status);
  });

  test('mapMetaError uses the status for auth failures and falls back to other', () => {
    expect(mapMetaError(403, undefined)).toBe('access');
    expect(mapMetaError(401, undefined)).toBe('access');
    expect(mapMetaError(500, undefined)).toBe('other');
    expect(mapMetaError(400, { error: { code: 4 } })).toBe('other');
  });

  test('a 2xx answer that carries an error key is still a failure', async () => {
    const { http } = clientWith(() => json(fixture('error-token.json'), 200));

    const error = await http.get('/act_1').then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AdPlatformError);
    expect((error as AdPlatformError).kind).toBe('access');
  });
});

describe('secrets and provider text stay out of errors', () => {
  test.each(ERROR_CASES)('$file: the thrown error exposes no token, secret, proof or provider text', async ({ file, status }) => {
    const providerMessage = (JSON.parse(fixture(file)) as { error: { message: string } }).error.message;

    const error = (await thrownBy(file, status)) as AdPlatformError;

    const surfaces = [error.message, error.name, error.stack ?? '', String(error), JSON.stringify(error)].join('\n');
    for (const secret of [TOKEN, SECRET, EXPECTED_PROOF, providerMessage]) {
      expect(surfaces).not.toContain(secret);
    }
  });
});

describe('secrets are never logged', () => {
  test('no console method is called during successes or failures', async () => {
    const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m));

    const ok = clientWith(() => json({ name: 'Acme', currency: 'USD' }));
    await ok.http.get('/act_1', { fields: 'name,currency' });
    await ok.http.post('/act_1/campaigns', { name: 'x' });

    for (const file of ['error-token.json', 'error-policy.json', 'error-unknown.json']) {
      await thrownBy(file, 400);
    }
    const broken = clientWith(() => {
      throw new TypeError('fetch failed');
    });
    await broken.http.get('/act_1').catch(() => undefined);

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe('network failures', () => {
  test('a rejected fetch throws AdPlatformError other with no status', async () => {
    const { http } = clientWith(() => {
      throw new TypeError('fetch failed');
    });

    const error = await http.get('/act_1').then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AdPlatformError);
    expect((error as AdPlatformError).kind).toBe('other');
    expect((error as AdPlatformError).status).toBeUndefined();
  });

  test('a timed-out or aborted request throws AdPlatformError other', async () => {
    const { http } = clientWith(() => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });

    const error = await http.post('/act_1/campaigns', { name: 'x' }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AdPlatformError);
    expect((error as AdPlatformError).kind).toBe('other');
  });
});

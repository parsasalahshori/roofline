import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * Final review: checkSignature (the voice recording, transfer whisper and whisper-result hooks) refuses a request
 * with no X-Twilio-Signature, or an empty one, before it looks up the company's signing token. The lookups are
 * counted through a wrapper around the real system query, as twilio-registration-lookups.test.ts does.
 */

const lookups = vi.hoisted(() => ({ companies: [] as string[] }));

vi.mock('@roofline/db/system', async (importOriginal) => {
  const actual = await importOriginal<{ signingTokenFor: (system: unknown, companyId: string, ...rest: unknown[]) => Promise<string | null> }>();
  return {
    ...actual,
    signingTokenFor: async (system: unknown, companyId: string, ...rest: unknown[]) => {
      lookups.companies.push(companyId);
      return actual.signingTokenFor(system, companyId, ...rest);
    },
  };
});

let t: TestApp;

const fields = { CallSid: `CA${'a'.repeat(32)}`, RecordingSid: `RE${'1'.repeat(32)}`, RecordingStatus: 'completed', RecordingDuration: '9' };
const path = () => `/hooks/twilio/voice/recording?c=${t.seed.a.companyId}`;

beforeEach(async () => {
  t = await makeTestApp();
  lookups.companies = [];
});

afterEach(async () => {
  await t.close();
});

describe('checkSignature lookups', () => {
  test('an unsigned request is 403 before any signing-token lookup', async () => {
    const res = await request(t.app).post(path()).type('form').send(fields);
    expect(res.status).toBe(403);
    expect(lookups.companies).toEqual([]);
  });

  test('an empty signature is 403 before any signing-token lookup', async () => {
    const res = await request(t.app).post(path()).type('form').set('X-Twilio-Signature', '').send(fields);
    expect(res.status).toBe(403);
    expect(lookups.companies).toEqual([]);
  });

  test('a signed (if wrong) request still looks the token up once and is 403', async () => {
    const res = await request(t.app).post(path()).type('form').set('X-Twilio-Signature', 'not-a-real-signature').send(fields);
    expect(res.status).toBe(403);
    expect(lookups.companies).toEqual([t.seed.a.companyId]);
  });
});

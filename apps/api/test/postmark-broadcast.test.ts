import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';
import type { BroadcastMail } from '../src/providers/broadcast.ts';
import { PostmarkBroadcastMailer, postmarkBroadcastFor } from '../src/providers/postmark-broadcast.ts';

const KEY = Buffer.alloc(32, 9).toString('base64');

const VALID = {
  NODE_ENV: 'production',
  APP_ORIGIN: 'https://app.roofline.test',
  DATABASE_URL_TENANT: 'postgres://app_tenant:pw@localhost:5432/roofline',
  DATABASE_URL_SYSTEM: 'postgres://app_system:pw@localhost:5432/roofline',
  ENCRYPTION_KEY: KEY,
  PUBLIC_BASE_URL: 'https://app.roofline.test',
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'key-id',
  R2_SECRET_ACCESS_KEY: 'key-secret',
  R2_BUCKET: 'proposals',
  TRUST_PROXY: '1',
} satisfies Record<string, string>;

const MAIL: BroadcastMail = {
  to: 'homeowner@example.test',
  from: 'storms@mail.example.com',
  replyTo: null,
  subject: 'Hail near you',
  text: 'Plain text body',
  html: '<p>HTML body</p>',
  unsubscribeUrl: 'https://app.example.test/u/TOKEN',
  tag: 'storm-alert',
};

type Recorded = { url: string; init: RequestInit };

function recordingFetch(response: Response): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function okResponse(): Response {
  return new Response(JSON.stringify({ MessageID: 'pm-1', ErrorCode: 0, Message: 'OK' }), { status: 200 });
}

function bodyOf(call: Recorded): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe('PostmarkBroadcastMailer', () => {
  test('posts to the broadcast stream with unsubscribe headers and metadata', async () => {
    const { fetch, calls } = recordingFetch(okResponse());
    const mailer = new PostmarkBroadcastMailer({ token: 'server-token', stream: 'broadcast', fetch });

    const result = await mailer.send(MAIL);

    expect(result).toEqual({ messageId: 'pm-1' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.postmarkapp.com/email');
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['X-Postmark-Server-Token']).toBe('server-token');
    expect(headers['Accept']).toBe('application/json');
    expect(headers['Content-Type']).toBe('application/json');

    const body = bodyOf(call);
    expect(body['MessageStream']).toBe('broadcast');
    expect(body['Tag']).toBe('storm-alert');
    expect(body['From']).toBe('storms@mail.example.com');
    expect(body['To']).toBe('homeowner@example.test');
    expect(body['Subject']).toBe('Hail near you');
    expect(body['TextBody']).toBe('Plain text body');
    expect(body['HtmlBody']).toBe('<p>HTML body</p>');
    expect(body['TrackOpens']).toBe(false);
    expect(body['Headers']).toEqual([
      { Name: 'List-Unsubscribe', Value: '<https://app.example.test/u/TOKEN>' },
      { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
    ]);
    expect(body['Metadata']).toEqual({ unsubscribe: 'TOKEN' });
  });

  test('ReplyTo is omitted when null and included when set', async () => {
    const plain = recordingFetch(okResponse());
    await new PostmarkBroadcastMailer({ token: 't', stream: 'broadcast', fetch: plain.fetch }).send(MAIL);
    expect('ReplyTo' in bodyOf(plain.calls[0]!)).toBe(false);

    const withReply = recordingFetch(okResponse());
    await new PostmarkBroadcastMailer({ token: 't', stream: 'broadcast', fetch: withReply.fetch }).send({
      ...MAIL,
      replyTo: 'support@example.test',
    });
    expect(bodyOf(withReply.calls[0]!)['ReplyTo']).toBe('support@example.test');
  });

  test('a rejected send throws a status-only message without provider text', async () => {
    const rejected = new Response(JSON.stringify({ ErrorCode: 406, Message: 'secret provider words' }), { status: 422 });
    const { fetch } = recordingFetch(rejected);
    const mailer = new PostmarkBroadcastMailer({ token: 't', stream: 'broadcast', fetch });

    const err = await mailer.send(MAIL).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe('Postmark broadcast send failed (422).');
    expect(err?.message).not.toContain('secret provider words');
  });

  test('a network failure throws a plain message without the original text', async () => {
    const failing = (async () => {
      throw new Error('boom host');
    }) as unknown as typeof fetch;
    const mailer = new PostmarkBroadcastMailer({ token: 't', stream: 'broadcast', fetch: failing });

    const err = await mailer.send(MAIL).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toBe('Postmark broadcast send could not reach Postmark.');
    expect(err?.message).not.toContain('boom host');
  });

  test('a 2xx response without a MessageID throws', async () => {
    const { fetch } = recordingFetch(new Response(JSON.stringify({ ErrorCode: 0 }), { status: 200 }));
    const mailer = new PostmarkBroadcastMailer({ token: 't', stream: 'broadcast', fetch });

    await expect(mailer.send(MAIL)).rejects.toThrow('Postmark broadcast send returned no message id.');
  });
});

describe('postmarkBroadcastFor', () => {
  test('returns null without POSTMARK_TOKEN', () => {
    expect(postmarkBroadcastFor(loadConfig(VALID))).toBeNull();
  });

  test('returns a configured mailer when POSTMARK_TOKEN is set', () => {
    const config = loadConfig({
      ...VALID,
      POSTMARK_TOKEN: 'pm-token',
      MAIL_FROM: 'Roofline <hello@mail.example.com>',
    });
    const mailer = postmarkBroadcastFor(config);
    expect(mailer).not.toBeNull();
    expect(mailer?.configured).toBe(true);
  });
});

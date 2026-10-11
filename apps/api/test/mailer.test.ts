import { describe, expect, test, vi } from 'vitest';
import { ConsoleMailer, PostmarkMailer } from '../src/mailer.ts';

type Call = { url: string; init: RequestInit };

function fakeFetch(response: Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(response);
  };
  return { fetch: impl as typeof fetch, calls };
}

describe('PostmarkMailer', () => {
  test('posts the message to Postmark with the server token', async () => {
    const { fetch, calls } = fakeFetch(new Response('{"ErrorCode":0,"Message":"OK"}', { status: 200 }));
    const mailer = new PostmarkMailer({ token: 'server-token', from: 'Roofline <hello@roofline.test>', fetch });
    await mailer.send({ to: 'owner@a.test', subject: 'Verify your email', text: 'Click the link.' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.postmarkapp.com/email');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers).toMatchObject({
      'X-Postmark-Server-Token': 'server-token',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      From: 'Roofline <hello@roofline.test>',
      To: 'owner@a.test',
      Subject: 'Verify your email',
      TextBody: 'Click the link.',
      MessageStream: 'outbound',
    });
  });

  test('throws when Postmark refuses the message, without echoing the token', async () => {
    const { fetch } = fakeFetch(
      new Response('{"ErrorCode":300,"Message":"Invalid email request"}', { status: 422 }),
    );
    const mailer = new PostmarkMailer({ token: 'server-token', from: 'hello@roofline.test', fetch });
    const send = mailer.send({ to: 'bad', subject: 's', text: 't' });
    await expect(send).rejects.toThrow(/422.*Invalid email request/);
    await expect(send).rejects.not.toThrow(/server-token/);
  });
});

describe('ConsoleMailer', () => {
  const msg = { to: 'owner@a.test', subject: 'Reset your password', text: 'https://app.roofline.test/reset?token=secret' };

  test('prints the whole message in development', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await new ConsoleMailer(true).send(msg);
    expect(String(log.mock.calls[0]?.[0])).toContain('token=secret');
    log.mockRestore();
  });

  test('leaves the body out in production, because it can hold a sign-in or reset link', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await new ConsoleMailer(false).send(msg);
    const printed = String(log.mock.calls[0]?.[0]);
    expect(printed).toContain('owner@a.test');
    expect(printed).not.toContain('secret');
    log.mockRestore();
  });
});

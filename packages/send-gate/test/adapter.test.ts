import { describe, expect, test } from 'vitest';
import { DisabledSmsAdapter, FakeSmsAdapter, type SmsAdapter, SmsRefusedError } from '../src/index.ts';

const msg = (body: string, to = '+14025550123') => ({ companyId: 'co-1', to, body });

describe('FakeSmsAdapter', () => {
  test('records what it sends, in order, and returns a distinct provider id each time', async () => {
    const sms: SmsAdapter = new FakeSmsAdapter();
    const a = await sms.send(msg('first'));
    const b = await sms.send(msg('second', '+14025550199'));
    expect((sms as FakeSmsAdapter).sent).toEqual([msg('first'), msg('second', '+14025550199')]);
    expect(a.providerSid).not.toBe(b.providerSid);
    expect(a.providerSid).toMatch(/\S/);
  });

  test('counts one segment up to 160 characters, then 153 per segment', async () => {
    const sms = new FakeSmsAdapter();
    const segments = async (n: number) => (await sms.send(msg('x'.repeat(n)))).segments;
    expect(await segments(0)).toBe(1);
    expect(await segments(160)).toBe(1);
    expect(await segments(161)).toBe(2);
    expect(await segments(306)).toBe(2);
    expect(await segments(307)).toBe(3);
    expect(await segments(459)).toBe(3);
    expect(await segments(460)).toBe(4);
  });

  test('failNext(n) refuses the next n sends (SmsRefusedError: definitely not sent), records none of them, then recovers', async () => {
    const sms = new FakeSmsAdapter();
    sms.failNext(2);
    await expect(sms.send(msg('a'))).rejects.toBeInstanceOf(SmsRefusedError);
    await expect(sms.send(msg('b'))).rejects.toBeInstanceOf(SmsRefusedError);
    expect(sms.sent).toEqual([]);
    await expect(sms.send(msg('c'))).resolves.toMatchObject({ segments: 1 });
    expect(sms.sent).toEqual([msg('c')]);
  });

  test('failUnknownNext(n) fails the next n sends with a plain error (the outcome is unknown), then recovers', async () => {
    const sms = new FakeSmsAdapter();
    sms.failUnknownNext(1);
    const error = await sms.send(msg('a')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SmsRefusedError);
    expect(sms.sent).toEqual([]);
    await expect(sms.send(msg('b'))).resolves.toMatchObject({ segments: 1 });
  });

  test('failNext and failUnknownNext each replace whatever failures are still pending', async () => {
    const sms = new FakeSmsAdapter();
    sms.failNext(3);
    sms.failUnknownNext(1);
    const first = await sms.send(msg('a')).catch((e: unknown) => e);
    expect(first).not.toBeInstanceOf(SmsRefusedError);
    await expect(sms.send(msg('b'))).resolves.toBeDefined();
  });

  test('a failure carries no phone number or message body', async () => {
    const sms = new FakeSmsAdapter();
    sms.failNext(1);
    const error = await sms.send(msg('Your estimate for 12 Oak St is ready', '+14025550123')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const text = `${(error as Error).message} ${(error as Error).stack ?? ''}`;
    expect(text).not.toContain('4025550123');
    expect(text).not.toContain('Oak St');
    expect(text).not.toContain('estimate');
  });

  test('failNext(0) clears pending failures', async () => {
    const sms = new FakeSmsAdapter();
    sms.failNext(3);
    sms.failNext(0);
    await expect(sms.send(msg('ok'))).resolves.toBeDefined();
  });
});

describe('DisabledSmsAdapter', () => {
  test('refuses every send with a plain sentence that carries no phone number or body', async () => {
    const sms: SmsAdapter = new DisabledSmsAdapter();
    const error = await sms.send(msg('Your estimate for 12 Oak St is ready', '+14025550123')).catch((e: unknown) => e);
    // A refusal: the text definitely did not go out, so it is safe to try again once texting is set up.
    expect(error).toBeInstanceOf(SmsRefusedError);
    expect((error as Error).message).toBe("Texting isn't set up yet.");
    const text = `${(error as Error).message} ${(error as Error).stack ?? ''}`;
    expect(text).not.toContain('4025550123');
    expect(text).not.toContain('Oak St');
  });
});

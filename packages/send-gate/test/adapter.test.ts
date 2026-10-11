import { describe, expect, test } from 'vitest';
import { DisabledSmsAdapter, FakeSmsAdapter, isSmsRefusedError, SMS_REFUSED, type SmsAdapter, SmsRefusedError } from '../src/index.ts';

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

  test('refuseNext(n, opts) refuses the next send with those fields, records nothing, then recovers', async () => {
    const sms = new FakeSmsAdapter();
    sms.refuseNext(1, { permanent: true, optedOut: true, reasonPlain: 'R' });
    const error = await sms.send(msg('a')).catch((e: unknown) => e);
    expect(isSmsRefusedError(error)).toBe(true);
    expect(error).toBeInstanceOf(SmsRefusedError);
    const refused = error as SmsRefusedError;
    expect(refused.permanent).toBe(true);
    expect(refused.optedOut).toBe(true);
    expect(refused.reasonPlain).toBe('R');
    expect(sms.sent).toEqual([]);
    await expect(sms.send(msg('b'))).resolves.toMatchObject({ segments: 1 });
    expect(sms.sent).toEqual([msg('b')]);
  });

  test('refuseNext(2) with no opts refuses with the defaults: retryable, not opted out, no reason', async () => {
    const sms = new FakeSmsAdapter();
    sms.refuseNext(2);
    for (const body of ['a', 'b']) {
      const error = await sms.send(msg(body)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SmsRefusedError);
      const refused = error as SmsRefusedError;
      expect(refused.permanent).toBe(false);
      expect(refused.optedOut).toBe(false);
      expect(refused.reasonPlain).toBeNull();
    }
    expect(sms.sent).toEqual([]);
  });

  test('refuseNext replaces any failures still pending', async () => {
    const sms = new FakeSmsAdapter();
    sms.refuseNext(3);
    sms.refuseNext(1, { permanent: true });
    const first = await sms.send(msg('a')).catch((e: unknown) => e);
    expect((first as SmsRefusedError).permanent).toBe(true);
    await expect(sms.send(msg('b'))).resolves.toBeDefined();
  });

  test('a later failNext does not carry refuseNext opts into its refusal', async () => {
    const sms = new FakeSmsAdapter();
    sms.refuseNext(1, { permanent: true, optedOut: true, reasonPlain: 'R' });
    sms.failNext(1);
    const error = await sms.send(msg('a')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmsRefusedError);
    const refused = error as SmsRefusedError;
    expect(refused.permanent).toBe(false);
    expect(refused.optedOut).toBe(false);
    expect(refused.reasonPlain).toBeNull();
  });

  test('a later failUnknownNext replaces refuseNext, so its error is a plain error', async () => {
    const sms = new FakeSmsAdapter();
    sms.refuseNext(1, { permanent: true });
    sms.failUnknownNext(1);
    const error = await sms.send(msg('a')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isSmsRefusedError(error)).toBe(false);
  });

  test('a refusal from refuseNext carries no phone number or message body', async () => {
    const sms = new FakeSmsAdapter();
    sms.refuseNext(1, { reasonPlain: 'R' });
    const error = await sms.send(msg('Your estimate for 12 Oak St is ready', '+14025550123')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const text = `${(error as Error).message} ${(error as Error).stack ?? ''}`;
    expect(text).not.toContain('4025550123');
    expect(text).not.toContain('Oak St');
    expect(text).not.toContain('estimate');
  });

  test('records no sender key when none was given', async () => {
    const sms = new FakeSmsAdapter();
    await sms.send(msg('hi'));
    expect('sender' in sms.sent[0]).toBe(false);
  });

  test('records no sender key when the sender is null', async () => {
    const sms = new FakeSmsAdapter();
    await sms.send({ ...msg('hi'), sender: null });
    expect('sender' in sms.sent[0]).toBe(false);
  });

  test('records the sender when the text carried one', async () => {
    const sms = new FakeSmsAdapter();
    await sms.send({ ...msg('hi'), sender: { accountSid: 'AC1', messagingServiceSid: 'MG1' } });
    expect(sms.sent[0]).toEqual({
      companyId: 'co-1',
      to: '+14025550123',
      body: 'hi',
      sender: { accountSid: 'AC1', messagingServiceSid: 'MG1' },
    });
  });
});

describe('SmsRefusedError and isSmsRefusedError', () => {
  test('isSmsRefusedError is true for a SmsRefusedError', () => {
    expect(isSmsRefusedError(new SmsRefusedError('x'))).toBe(true);
  });

  test('SMS_REFUSED is the registered symbol, so a look-alike from a second copy of the package is recognised', () => {
    expect(SMS_REFUSED).toBe(Symbol.for('roofline.sms.refused'));
    expect(isSmsRefusedError({ name: 'SmsRefusedError', [Symbol.for('roofline.sms.refused')]: true })).toBe(true);
  });

  test('is false for anything that is not a refusal', () => {
    expect(isSmsRefusedError(new Error('x'))).toBe(false);
    expect(isSmsRefusedError({ name: 'SmsRefusedError' })).toBe(false);
    expect(isSmsRefusedError({ [Symbol.for('roofline.sms.refused')]: true })).toBe(false);
    expect(isSmsRefusedError({ name: 'SmsRefusedError', [Symbol.for('roofline.sms.refused')]: false })).toBe(false);
    expect(isSmsRefusedError('SmsRefusedError')).toBe(false);
    expect(isSmsRefusedError(null)).toBe(false);
    expect(isSmsRefusedError(undefined)).toBe(false);
  });

  test('defaults: permanent false, optedOut false, reasonPlain null', () => {
    const e = new SmsRefusedError('x');
    expect(e.name).toBe('SmsRefusedError');
    expect(e.message).toBe('x');
    expect(e).toBeInstanceOf(Error);
    expect(e.permanent).toBe(false);
    expect(e.optedOut).toBe(false);
    expect(e.reasonPlain).toBeNull();
  });

  test('carries the permanent, optedOut and reasonPlain it was given', () => {
    const e = new SmsRefusedError('x', { permanent: true, optedOut: true, reasonPlain: 'R' });
    expect(e.permanent).toBe(true);
    expect(e.optedOut).toBe(true);
    expect(e.reasonPlain).toBe('R');
  });

  test('DisabledSmsAdapter refusals keep the F1 behaviour: retryable, not opted out, no reason', async () => {
    const sms: SmsAdapter = new DisabledSmsAdapter();
    const error = await sms.send(msg('hi')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SmsRefusedError);
    const refused = error as SmsRefusedError;
    expect(refused.permanent).toBe(false);
    expect(refused.optedOut).toBe(false);
    expect(refused.reasonPlain).toBeNull();
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

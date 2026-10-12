import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { companyPhoneNumbers, encrypt, textingRegistrations } from '@roofline/db';
import { ensureVoiceUrl, fdHealth, repairVoiceUrls } from '../../src/jobs/scheduler/fd-health.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from '../helpers.ts';

/*
 * D1 Task 17: the voice URL on each company's Twilio number. The URL is set once per number (the
 * marker 'voice_url' is appended to capabilities), by ensureVoiceUrl (first Front Desk save) or the
 * fd-health repair pass. Numbers of companies without a subaccount are skipped.
 */

let t: TestApp;
const BASE = 'https://app.roofline.test';
const VOICE_URL = `${BASE}/hooks/twilio/voice`;
const VOICE_STATUS_URL = `${BASE}/hooks/twilio/voice-status`;
const NOW = new Date('2026-10-12T15:00:00.000Z');

const E164_A1 = '+14025550201';
const E164_A2 = '+14025550202';
const E164_A_SMS = '+14025550203';
const E164_B1 = '+14025550301';
const SUB_A = 'AC' + 'a'.repeat(32);

const idOf = (company: 'a' | 'b') => t.seed[company].companyId;

beforeEach(async () => {
  t = await makeTestApp();
});

/** Gives a company its texting subaccount (sid and encrypted token), as advanceRegistration does. */
async function registerSubaccount(company: 'a' | 'b', sid: string, token: string): Promise<void> {
  const tokenEncrypted = encrypt(token, TEST_ENCRYPTION_KEY);
  await t.deps.pools.system
    .insert(textingRegistrations)
    .values({ companyId: idOf(company), subaccountSid: sid, subaccountAuthTokenEncrypted: tokenEncrypted })
    .onConflictDoUpdate({
      target: textingRegistrations.companyId,
      set: { subaccountSid: sid, subaccountAuthTokenEncrypted: tokenEncrypted },
    });
}

async function addNumber(
  company: 'a' | 'b',
  e164: string,
  providerSid: string,
  capabilities: string[],
  status = 'active',
): Promise<void> {
  await t.deps.pools.system.insert(companyPhoneNumbers).values({ companyId: idOf(company), e164, providerSid, capabilities, status });
}

/** The capabilities column of the number with this e164. */
async function capabilitiesOf(e164: string): Promise<string[]> {
  const [row] = await t.deps.pools.system
    .select({ capabilities: companyPhoneNumbers.capabilities })
    .from(companyPhoneNumbers)
    .where(eq(companyPhoneNumbers.e164, e164))
    .limit(1);
  return row!.capabilities;
}

/** The setVoiceUrl calls the fake recorded, in order. */
const voiceCalls = () => t.callControl.calls.filter((c) => c.method === 'setVoiceUrl');

describe('voice URL setup (D1 Task 17)', () => {
  test('a number without the marker gets setVoiceUrl once and the marker is added', async () => {
    await registerSubaccount('a', SUB_A, 'token-a');
    await addNumber('a', E164_A1, 'PN_A1', ['sms', 'voice']);

    expect(await ensureVoiceUrl(t.deps, idOf('a'))).toEqual({ set: 1, failed: 0 });

    const calls = voiceCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([{ accountSid: SUB_A, authToken: 'token-a' }, 'PN_A1', VOICE_URL, VOICE_STATUS_URL]);
    const caps = await capabilitiesOf(E164_A1);
    expect(caps).toContain('voice_url');
    expect(caps).toEqual(expect.arrayContaining(['sms', 'voice']));
  });

  test('a second run does nothing: the marker stops a repeat call', async () => {
    await registerSubaccount('a', SUB_A, 'token-a');
    await addNumber('a', E164_A1, 'PN_A1', ['sms', 'voice']);
    await ensureVoiceUrl(t.deps, idOf('a'));

    expect(await ensureVoiceUrl(t.deps, idOf('a'))).toEqual({ set: 0, failed: 0 });
    expect(voiceCalls()).toHaveLength(1);
    expect((await capabilitiesOf(E164_A1)).filter((c) => c === 'voice_url')).toHaveLength(1);
  });

  test('a failing setVoiceUrl does not abort the others and leaves that number unmarked', async () => {
    await registerSubaccount('a', SUB_A, 'token-a');
    await addNumber('a', E164_A1, 'PN_A1', ['sms', 'voice']);
    await addNumber('a', E164_A2, 'PN_A2', ['sms', 'voice']);
    t.callControl.failNext(1);

    expect(await ensureVoiceUrl(t.deps, idOf('a'))).toEqual({ set: 1, failed: 1 });
    expect(voiceCalls()).toHaveLength(2);
    const marked = [await capabilitiesOf(E164_A1), await capabilitiesOf(E164_A2)].filter((caps) => caps.includes('voice_url'));
    expect(marked).toHaveLength(1);

    // The failed number is retried on the next run; the marked one is not called again.
    expect(await ensureVoiceUrl(t.deps, idOf('a'))).toEqual({ set: 1, failed: 0 });
    expect(voiceCalls()).toHaveLength(3);
    expect(await capabilitiesOf(E164_A1)).toContain('voice_url');
    expect(await capabilitiesOf(E164_A2)).toContain('voice_url');
  });

  test('numbers of a company without a subaccount are skipped', async () => {
    await addNumber('b', E164_B1, 'PN_B1', ['sms', 'voice']);

    expect(await ensureVoiceUrl(t.deps, idOf('b'))).toEqual({ set: 0, failed: 0 });
    expect(voiceCalls()).toHaveLength(0);
    expect(await capabilitiesOf(E164_B1)).not.toContain('voice_url');

    // The seeded registration row has no subaccount yet, so the repair pass skips the number as well.
    expect(await repairVoiceUrls(t.deps, 20)).toEqual({ set: 0, failed: 0 });
    expect(voiceCalls()).toHaveLength(0);
  });

  test('only voice numbers that are active and have a provider sid are set', async () => {
    await registerSubaccount('a', SUB_A, 'token-a');
    await addNumber('a', E164_A1, 'PN_A1', ['sms', 'voice']);
    await addNumber('a', E164_A_SMS, 'PN_A_SMS', ['sms']);
    await addNumber('a', E164_A2, 'PN_A2', ['sms', 'voice'], 'released');

    expect(await ensureVoiceUrl(t.deps, idOf('a'))).toEqual({ set: 1, failed: 0 });
    expect(voiceCalls().map((c) => c.args[1])).toEqual(['PN_A1']);
    expect(await capabilitiesOf(E164_A_SMS)).not.toContain('voice_url');
    expect(await capabilitiesOf(E164_A2)).not.toContain('voice_url');
  });

  test('the repair pass sets numbers across companies and skips companies without a subaccount', async () => {
    await registerSubaccount('a', SUB_A, 'token-a');
    await addNumber('a', E164_A1, 'PN_A1', ['sms', 'voice']);
    await addNumber('b', E164_B1, 'PN_B1', ['sms', 'voice']);

    expect(await repairVoiceUrls(t.deps, 20)).toEqual({ set: 1, failed: 0 });
    expect(voiceCalls().map((c) => c.args[1])).toEqual(['PN_A1']);
    expect(await capabilitiesOf(E164_A1)).toContain('voice_url');
    expect(await capabilitiesOf(E164_B1)).not.toContain('voice_url');
  });

  test('the fd-health schedule runs the repair pass', async () => {
    await registerSubaccount('a', SUB_A, 'token-a');
    await addNumber('a', E164_A1, 'PN_A1', ['sms', 'voice']);

    await fdHealth(t.deps, NOW);

    expect(voiceCalls()).toHaveLength(1);
    expect(await capabilitiesOf(E164_A1)).toContain('voice_url');
  });

  test('a repair pass that finds nothing to do calls nothing', async () => {
    expect(await repairVoiceUrls(t.deps, 20)).toEqual({ set: 0, failed: 0 });
    await fdHealth(t.deps, NOW);
    expect(voiceCalls()).toHaveLength(0);
  });
});

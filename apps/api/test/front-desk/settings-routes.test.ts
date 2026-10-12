import pg from 'pg';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, inject, test } from 'vitest';
import { companies, companyPhoneNumbers, encrypt, memberships, textingRegistrations } from '@roofline/db';
import { FRONT_DESK_VOICES, type FrontDeskSettings, type FrontDeskVoice, type TransferPhoneView } from '@roofline/shared';
import { READ_ONLY_MESSAGE } from '../../src/billing/read-only.ts';
import { loginAs, makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from '../helpers.ts';

/*
 * D1 Task 18, package 2: Front Desk settings, voices and the transfer phone.
 * Company A has a voice number and a subaccount; company B has neither. Twilio is FakeCallControl.
 */

const SETTINGS = '/api/front-desk/settings';
const TRANSFER = '/api/me/transfer-phone';
const A_NUMBER = '+14025550200';
const NOT_ALLOWED = "Your role can't do that. Ask the owner.";

let t: TestApp;
const idOf = (company: 'a' | 'b') => t.seed[company].companyId;

beforeEach(async () => {
  t = await makeTestApp();
  const { system } = t.deps.pools;
  await system.insert(companyPhoneNumbers).values({ companyId: idOf('a'), e164: A_NUMBER, capabilities: ['sms', 'voice'], providerSid: 'PN_A' });
  await system
    .update(textingRegistrations)
    .set({ subaccountSid: 'AC_A', subaccountAuthTokenEncrypted: encrypt('token-a', TEST_ENCRYPTION_KEY) })
    .where(eq(textingRegistrations.companyId, idOf('a')));
});

async function ownerSql(text: string, params: unknown[] = []): Promise<void> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    await client.query(text, params);
  } finally {
    await client.end();
  }
}

const verify = (company: 'a' | 'b') =>
  ownerSql('update company_settings set forwarding_verified_at = now() where company_id = $1', [idOf(company)]);

/** A complete valid PUT body. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: false,
    texts: true,
    voice: 'claire',
    facts: 'Open Monday to Friday.',
    canMove: true,
    canCancel: false,
    ringTeamFirstSeconds: 10,
    missedCallTextBack: true,
    recordingRetentionDays: 30,
    transcriptRetentionDays: 90,
    maxConcurrentAiCalls: 3,
    onCallOrder: [],
    ...overrides,
  };
}

const voiceCalls = () => t.callControl.calls.filter((c) => c.method === 'setVoiceUrl');

describe('GET /api/front-desk/settings', () => {
  test('settings GET shape and blockedReason', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await owner.get(SETTINGS);
    expect(res.status).toBe(200);
    const view = res.body as FrontDeskSettings;
    expect(view).toMatchObject({
      enabled: false,
      blockedReason: 'forwarding_not_verified',
      texts: true,
      voice: 'maya',
      facts: '',
      ringTeamFirstSeconds: 0,
      recordingRetentionDays: 90,
      transcriptRetentionDays: 365,
      maxConcurrentAiCalls: 4,
      forwardingVerifiedAt: null,
    });
    expect(view.onCall.map((m) => m.userId)).toContain(t.seed.a.rep.userId);
    expect(view.onCall.every((m) => m.onCallOrder === null && m.transferPhoneE164 === null && !m.recordingAcknowledged)).toBe(true);

    await verify('a');
    expect(((await owner.get(SETTINGS)).body as FrontDeskSettings).blockedReason).toBeNull();
    expect(((await owner.get(SETTINGS)).body as FrontDeskSettings).forwardingVerifiedAt).toEqual(expect.any(String));

    const ownerB = await loginAs(t.app, t.seed.b.owner);
    expect(((await ownerB.get(SETTINGS)).body as FrontDeskSettings).blockedReason).toBe('no_number');
  });

  test('rep gets 403', async () => {
    const rep = await loginAs(t.app, t.seed.a.rep);
    for (const res of [await rep.get(SETTINGS), await rep.put(SETTINGS).send(body())]) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: NOT_ALLOWED });
    }
  });
});

describe('PUT /api/front-desk/settings', () => {
  test('PUT validation (facts 2001 chars, ring seconds 31, bad voice, bad onCallOrder id)', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const cases: [Record<string, unknown>, string][] = [
      [{ facts: 'x'.repeat(2001) }, 'facts'],
      [{ ringTeamFirstSeconds: 31 }, 'ringTeamFirstSeconds'],
      [{ ringTeamFirstSeconds: 1.5 }, 'ringTeamFirstSeconds'],
      [{ recordingRetentionDays: 366 }, 'recordingRetentionDays'],
      [{ transcriptRetentionDays: 29 }, 'transcriptRetentionDays'],
      [{ maxConcurrentAiCalls: 0 }, 'maxConcurrentAiCalls'],
      [{ voice: 'robot' }, 'voice'],
      [{ onCallOrder: ['not-a-uuid'] }, 'onCallOrder.0'],
      [{ onCallOrder: [t.seed.b.owner.userId] }, 'onCallOrder'],
    ];
    for (const [override, field] of cases) {
      const res = await owner.put(SETTINGS).send(body(override));
      expect(res.status, field).toBe(400);
      expect((res.body as { field?: string }).field).toBe(field);
      expect(typeof (res.body as { error: string }).error).toBe('string');
    }
    expect(((await owner.get(SETTINGS)).body as FrontDeskSettings).voice).toBe('maya');
  });

  test('a valid save stores the values and the on-call order', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const order = [t.seed.a.rep.userId, t.seed.a.owner.userId];
    const res = await owner.put(SETTINGS).send(body({ onCallOrder: order }));
    expect(res.status).toBe(200);
    const view = res.body as FrontDeskSettings;
    expect(view).toMatchObject({ voice: 'claire', facts: 'Open Monday to Friday.', canCancel: false, ringTeamFirstSeconds: 10 });
    expect(view.onCall.slice(0, 2).map((m) => [m.userId, m.onCallOrder])).toEqual([
      [order[0], 0],
      [order[1], 1],
    ]);
    expect(view.onCall.slice(2).every((m) => m.onCallOrder === null)).toBe(true);
    // Left out of the list: taken off.
    const again = await owner.put(SETTINGS).send(body({ onCallOrder: [t.seed.a.owner.userId] }));
    expect((again.body as FrontDeskSettings).onCall.filter((m) => m.onCallOrder !== null).map((m) => m.userId)).toEqual([t.seed.a.owner.userId]);
  });

  test('enable blocked before verification', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await owner.put(SETTINGS).send(body({ enabled: true }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ field: 'enabled' });
    expect(((await owner.get(SETTINGS)).body as FrontDeskSettings).enabled).toBe(false);

    await verify('a');
    const ok = await owner.put(SETTINGS).send(body({ enabled: true }));
    expect(ok.status).toBe(200);
    expect((ok.body as FrontDeskSettings).enabled).toBe(true);
  });

  test('a company without a number cannot enable, even with override', async () => {
    const ownerB = await loginAs(t.app, t.seed.b.owner);
    const res = await ownerB.put(SETTINGS).send(body({ enabled: true, override: true }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ field: 'enabled' });
  });

  test('office can save but cannot override', async () => {
    const office = await loginAs(t.app, t.seed.a.office);
    expect((await office.put(SETTINGS).send(body())).status).toBe(200);
    const res = await office.put(SETTINGS).send(body({ enabled: true, override: true }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ field: 'enabled' });
    expect(((await office.get(SETTINGS)).body as FrontDeskSettings).enabled).toBe(false);
  });

  test('owner override:true enables without verification', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await owner.put(SETTINGS).send(body({ enabled: true, override: true }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, blockedReason: 'forwarding_not_verified', forwardingVerifiedAt: null });
  });

  test('first save sets voice url on the number', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    await owner.put(SETTINGS).send(body());
    expect(voiceCalls()).toHaveLength(1);
    const [row] = await t.deps.pools.system
      .select({ caps: companyPhoneNumbers.capabilities })
      .from(companyPhoneNumbers)
      .where(eq(companyPhoneNumbers.e164, A_NUMBER));
    expect(row!.caps).toContain('voice_url');

    await owner.put(SETTINGS).send(body({ enabled: true, override: true }));
    expect(voiceCalls()).toHaveLength(1);

    await owner.put(SETTINGS).send(body({ enabled: true, facts: 'Changed.' }));
    expect(voiceCalls()).toHaveLength(1);
  });

  test('a failing voice URL setup never fails the save', async () => {
    t.callControl.failNext(1);
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await owner.put(SETTINGS).send(body({ enabled: true, override: true }));
    expect(res.status).toBe(200);
    expect((res.body as FrontDeskSettings).enabled).toBe(true);
  });
});

describe('GET /api/front-desk/voices', () => {
  test('voices list', async () => {
    for (const user of [t.seed.a.owner, t.seed.a.rep]) {
      const res = await (await loginAs(t.app, user)).get('/api/front-desk/voices');
      expect(res.status).toBe(200);
      expect(res.body as FrontDeskVoice[]).toEqual(FRONT_DESK_VOICES.map((v) => ({ id: v.id, label: v.label, previewUrl: null })));
    }
  });
});

describe('read-only company (Ruling BG)', () => {
  test('a read-only company can turn Front Desk off and nothing else', async () => {
    await verify('a');
    const owner = await loginAs(t.app, t.seed.a.owner);
    expect((await owner.put(SETTINGS).send(body({ enabled: true, facts: 'Before.' }))).status).toBe(200);
    await ownerSql("update companies set status = 'trial_ended' where id = $1", [idOf('a')]);

    const refused = await owner.put(SETTINGS).send(body({ enabled: true, facts: 'Changed.' }));
    expect(refused.status).toBe(403);

    const off = await owner.put(SETTINGS).send(body({ enabled: false, facts: 'Changed.', voice: 'marcus' }));
    expect(off.status).toBe(200);
    expect(off.body as FrontDeskSettings).toMatchObject({ enabled: false, facts: 'Before.', voice: 'claire' });

    const rep = await loginAs(t.app, t.seed.a.rep);
    expect((await rep.put(SETTINGS).send(body({ enabled: false }))).status).toBe(403);
    expect((await owner.put(TRANSFER).send({ e164: '+14025550122', ackRecording: true })).status).toBe(403);
  });
});

describe('business phone change (pre-review #38)', () => {
  test('changing the business phone clears the forwarding test result; other edits keep it', async () => {
    await verify('a');
    const owner = await loginAs(t.app, t.seed.a.owner);
    expect((await owner.patch('/api/company').send({ name: 'Acme Renamed' })).status).toBe(200);
    expect(((await owner.get(SETTINGS)).body as FrontDeskSettings).forwardingVerifiedAt).not.toBeNull();

    expect((await owner.patch('/api/company').send({ phone: '(402) 555-0177' })).status).toBe(200);
    const view = (await owner.get(SETTINGS)).body as FrontDeskSettings;
    expect(view.forwardingVerifiedAt).toBeNull();
    expect(view.blockedReason).toBe('forwarding_not_verified');
  });
});

describe('/api/me/transfer-phone', () => {
  test('transfer phone: prefill from user phone, PUT needs ackRecording true, E.164 required, stores for own membership only', async () => {
    await ownerSql('update users set phone_e164 = $1 where id = $2', ['+14025550111', t.seed.a.rep.userId]);
    const rep = await loginAs(t.app, t.seed.a.rep);

    const first = await rep.get(TRANSFER);
    expect(first.status).toBe(200);
    expect(first.body as TransferPhoneView).toEqual({ e164: null, prefill: '+14025550111', recordingAcknowledgedAt: null });

    const noAck = await rep.put(TRANSFER).send({ e164: '+14025550122' });
    expect(noAck.status).toBe(400);
    expect(noAck.body).toMatchObject({ field: 'ackRecording' });
    const falseAck = await rep.put(TRANSFER).send({ e164: '+14025550122', ackRecording: false });
    expect(falseAck.status).toBe(400);
    expect(falseAck.body).toMatchObject({ field: 'ackRecording' });
    for (const bad of ['4025550122', '+0123456789', '+1402', 'call me']) {
      const res = await rep.put(TRANSFER).send({ e164: bad, ackRecording: true });
      expect(res.status, bad).toBe(400);
      expect(res.body).toMatchObject({ field: 'e164' });
    }
    expect((await rep.get(TRANSFER)).body).toMatchObject({ e164: null });

    const ok = await rep.put(TRANSFER).send({ e164: '+14025550122', ackRecording: true });
    expect(ok.status).toBe(200);
    expect(ok.body as TransferPhoneView).toMatchObject({ e164: '+14025550122', prefill: '+14025550111', recordingAcknowledgedAt: expect.any(String) });

    const rows = await t.deps.pools.system
      .select({ userId: memberships.userId, phone: memberships.transferPhoneE164, ack: memberships.recordingAckAt })
      .from(memberships);
    for (const row of rows) {
      if (row.userId === t.seed.a.rep.userId) {
        expect(row.phone).toBe('+14025550122');
        expect(row.ack).toBeInstanceOf(Date);
      } else {
        expect(row.phone).toBeNull();
        expect(row.ack).toBeNull();
      }
    }
  });

  test('transfer phone: only a US number that is not the company own line (pre-review #13)', async () => {
    await ownerSql('update companies set phone_e164 = $1 where id = $2', ['+14025550199', idOf('a')]);
    const rep = await loginAs(t.app, t.seed.a.rep);
    for (const bad of ['+18005550123', '+19005550123', '+14165550123', '+18765550123', '+442071234567', '+8821234567', A_NUMBER, '+14025550199']) {
      const res = await rep.put(TRANSFER).send({ e164: bad, ackRecording: true });
      expect(res.status, bad).toBe(400);
      expect(res.body, bad).toMatchObject({ field: 'e164' });
    }
    expect((await rep.get(TRANSFER)).body).toMatchObject({ e164: null });
    // A US territory number is a US number.
    const ok = await rep.put(TRANSFER).send({ e164: '+17875550123', ackRecording: true });
    expect(ok.status).toBe(200);
  });

  test('cross-tenant: a user of company B never changes company A', async () => {
    const ownerB = await loginAs(t.app, t.seed.b.owner);
    await ownerB.put(TRANSFER).send({ e164: '+14025550133', ackRecording: true });
    await ownerB.put(SETTINGS).send(body({ voice: 'marcus', facts: 'Bolt only.' }));
    await ownerB.put(SETTINGS).send(body({ onCallOrder: [t.seed.a.owner.userId] }));

    const ownerA = await loginAs(t.app, t.seed.a.owner);
    const view = (await ownerA.get(SETTINGS)).body as FrontDeskSettings;
    expect(view).toMatchObject({ voice: 'maya', facts: '' });
    expect(view.onCall.every((m) => m.onCallOrder === null && m.transferPhoneE164 === null)).toBe(true);
    expect((await ownerA.get(TRANSFER)).body).toMatchObject({ e164: null });
  });
});

describe('read-only company', () => {
  test('a company whose trial ended can turn Front Desk off but not on', async () => {
    await verify('a');
    await t.deps.pools.system.update(companies).set({ status: 'trial_ended' }).where(eq(companies.id, idOf('a')));
    const owner = await loginAs(t.app, t.seed.a.owner);
    const off = await owner.put(SETTINGS).send(body({ enabled: false }));
    expect(off.status).toBe(200);
    const on = await owner.put(SETTINGS).send(body({ enabled: true }));
    expect(on.status).toBe(403);
    expect(on.body).toEqual({ error: READ_ONLY_MESSAGE.trial_ended });
  });
});

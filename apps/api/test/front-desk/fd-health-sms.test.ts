import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { companies, companySettings, conversations } from '@roofline/db';
import { fdHealth, queueIdleSmsAfterCalls } from '../../src/jobs/scheduler/fd-health.ts';
import { inCompany } from '../crm-helpers.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';

/* The fd-health pass queues fd-after-call for SMS threads idle over 24 hours. Database-backed: CI runs it. */

let t: TestApp;
const HOUR = 3600_000;
const A_NUMBER = '+14025550100';
/** The start of an idle-SMS slot (minute 0 UTC). */
const SLOT = new Date('2026-10-13T15:00:00.000Z');

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(SLOT);
  await setTexts(t.seed.a.companyId, true);
});

async function setTexts(companyId: string, texts: boolean): Promise<void> {
  await inCompany(t, companyId, (tx) =>
    tx
      .insert(companySettings)
      .values({ companyId, frontDeskEnabled: true, frontDeskTexts: texts })
      .onConflictDoUpdate({ target: companySettings.companyId, set: { frontDeskEnabled: true, frontDeskTexts: texts } }),
  );
}

type Seed = { channel: 'sms' | 'voice'; status: 'active' | 'ended'; hoursAgo: number; phone: string; summary?: string; outcome?: 'spam' };

async function seed(companyId: string, o: Seed): Promise<string> {
  return inCompany(t, companyId, async (tx) => {
    const [row] = await tx
      .insert(conversations)
      .values({
        companyId,
        channel: o.channel,
        phoneE164: o.phone,
        companyNumberE164: A_NUMBER,
        status: o.status,
        lastMessageAt: new Date(t.clock.now().getTime() - o.hoursAgo * HOUR),
        ...(o.summary !== undefined ? { summary: o.summary } : {}),
        ...(o.outcome !== undefined ? { outcome: o.outcome } : {}),
      })
      .returning({ id: conversations.id });
    return row!.id;
  });
}

const sends = () => t.jobs.sent.filter((j) => j.name === 'fd-after-call');

describe('fdHealth idle SMS pass', () => {
  test('queues exactly the idle active SMS conversation', async () => {
    const a = t.seed.a.companyId;
    const idle = await seed(a, { channel: 'sms', status: 'active', hoursAgo: 25, phone: '+14025550201' });
    await seed(a, { channel: 'sms', status: 'active', hoursAgo: 1, phone: '+14025550202' });
    await seed(a, { channel: 'voice', status: 'active', hoursAgo: 25, phone: '+14025550203' });
    await seed(a, { channel: 'sms', status: 'ended', hoursAgo: 25, phone: '+14025550204', summary: 'Done.' });
    await fdHealth(t.deps, t.clock.now());
    expect(sends()).toHaveLength(1);
    expect(sends()[0]!.data).toEqual({ companyId: a, conversationId: idle });
    expect(sends()[0]!.singletonKey).toBe(`fd-after-call:sms:${idle}`);
  });

  test('a thread the 24 h gap already ended without a summary is queued; a spam-ended one is not (RC-2 #5)', async () => {
    const a = t.seed.a.companyId;
    const gapEnded = await seed(a, { channel: 'sms', status: 'ended', hoursAgo: 30, phone: '+14025550211' });
    await seed(a, { channel: 'sms', status: 'ended', hoursAgo: 30, phone: '+14025550212', outcome: 'spam' });
    await seed(a, { channel: 'sms', status: 'ended', hoursAgo: 8 * 24, phone: '+14025550213' });
    await fdHealth(t.deps, t.clock.now());
    expect(sends().map((j) => j.data)).toEqual([{ companyId: a, conversationId: gapEnded }]);
  });

  test('runs at most every 30 minutes: off-slot fd-health runs queue nothing (RC-2 #6)', async () => {
    const a = t.seed.a.companyId;
    await seed(a, { channel: 'sms', status: 'active', hoursAgo: 25, phone: '+14025550221' });
    for (const minute of [2, 4, 10, 28, 32, 58]) {
      await fdHealth(t.deps, new Date(SLOT.getTime() + minute * 60_000));
    }
    expect(sends()).toHaveLength(0);
    await fdHealth(t.deps, new Date(SLOT.getTime() + 30 * 60_000));
    expect(sends()).toHaveLength(1);
  });

  test('skips a read-only company and one with Front Desk texting off (RC-2 #6)', async () => {
    const a = t.seed.a.companyId;
    const b = t.seed.b.companyId;
    await seed(a, { channel: 'sms', status: 'active', hoursAgo: 25, phone: '+14025550231' });
    await seed(b, { channel: 'sms', status: 'active', hoursAgo: 25, phone: '+14025550232' });
    await setTexts(b, false);
    await t.deps.pools.system.update(companies).set({ status: 'trial_ended' }).where(eq(companies.id, a));
    await queueIdleSmsAfterCalls(t.deps, t.clock.now());
    expect(sends()).toHaveLength(0);

    await t.deps.pools.system.update(companies).set({ status: 'active' }).where(eq(companies.id, a));
    await setTexts(b, true);
    await queueIdleSmsAfterCalls(t.deps, t.clock.now());
    expect(sends()).toHaveLength(2);
  });
});

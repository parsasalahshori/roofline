import { beforeEach, describe, expect, test } from 'vitest';
import { conversations } from '@roofline/db';
import { fdHealth } from '../../src/jobs/scheduler/fd-health.ts';
import { inCompany } from '../crm-helpers.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';

/* The fd-health pass queues fd-after-call for SMS threads idle over 24 hours. Database-backed: CI runs it. */

let t: TestApp;
const HOUR = 3600_000;
const A_NUMBER = '+14025550100';

beforeEach(async () => {
  t = await makeTestApp();
});

type Seed = { channel: 'sms' | 'voice'; status: 'active' | 'ended'; hoursAgo: number; phone: string };

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
      })
      .returning({ id: conversations.id });
    return row!.id;
  });
}

describe('fdHealth idle SMS pass', () => {
  test('queues exactly the idle active SMS conversation', async () => {
    const a = t.seed.a.companyId;
    const idle = await seed(a, { channel: 'sms', status: 'active', hoursAgo: 25, phone: '+14025550201' });
    await seed(a, { channel: 'sms', status: 'active', hoursAgo: 1, phone: '+14025550202' });
    await seed(a, { channel: 'voice', status: 'active', hoursAgo: 25, phone: '+14025550203' });
    await seed(a, { channel: 'sms', status: 'ended', hoursAgo: 25, phone: '+14025550204' });
    await fdHealth(t.deps, t.clock.now());
    const sends = t.jobs.sent.filter((j) => j.name === 'fd-after-call');
    expect(sends).toHaveLength(1);
    expect(sends[0]!.data).toEqual({ companyId: a, conversationId: idle });
    expect(sends[0]!.singletonKey).toBe(`fd-after-call:sms:${idle}`);
  });
});

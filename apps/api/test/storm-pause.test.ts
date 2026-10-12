import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { agentTasks, setPaused } from '@roofline/db';
import { draftStormPlan } from '../src/storm/plan.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

const stormTasks = (companyId: string) =>
  inCompany(t, companyId, (tx) => tx.select().from(agentTasks).where(eq(agentTasks.agent, 'storm_scout')));

describe('Storm Scout pause', () => {
  test('a paused Storm Scout drafts nothing', async () => {
    const companyId = t.seed.a.companyId;
    await inCompany(t, companyId, (tx) =>
      setPaused(tx, { companyId, userId: null, role: 'system', canApproveSpend: false }, 'storm_scout', true, t.clock.now()),
    );
    await expect(draftStormPlan(t.deps, companyId, randomUUID())).resolves.toBeUndefined();
    expect(await stormTasks(companyId)).toHaveLength(0);
  });

  // When S1 Task 11 fills the drafting body, this test must assert that a draft task is created instead.
  test('an unpaused Storm Scout reaches the drafting body', async () => {
    await expect(draftStormPlan(t.deps, t.seed.a.companyId, randomUUID())).rejects.toThrow('not yet');
  });
});

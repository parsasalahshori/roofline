import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { createPools } from '../src/pools.ts';
import { insertAgentEvent, listRecentEvents, listTaskEvents } from '../src/repos/agent-events.ts';
import { insertTask, listSteps, setStepSnapshot, sumStepMinutesSaved } from '../src/repos/tasks.ts';
import { loadBaselineOverrides } from '../src/repos/time-baselines.ts';
import { agentTaskSteps, timeBaselines } from '../src/schema/index.ts';
import { type TenantContext, withTenant } from '../src/tenant.ts';
import { resetDb, type SeededCompany, seedTwoCompanies } from '../src/testing/index.ts';

const urls = inject('dbUrls');
const pools = createPools({ tenant: urls.tenant, system: urls.system });

let seed: { a: SeededCompany; b: SeededCompany };

afterAll(async () => {
  await pools.end();
});

beforeEach(async () => {
  await resetDb(urls.owner);
  seed = await seedTwoCompanies(urls.owner);
});

function ctxFor(c: SeededCompany): TenantContext {
  return { companyId: c.companyId, userId: c.owner.userId, role: 'owner', canApproveSpend: true };
}

const t0 = new Date('2026-10-12T10:00:00Z');

/** A draft task with `count` pending steps; returns the task id and the step ids in order. */
function makeTask(c: SeededCompany, count = 1) {
  const ctx = ctxFor(c);
  return withTenant(pools, ctx, async (tx) => {
    const { taskId } = await insertTask(
      tx,
      ctx,
      {
        agent: 'front_desk',
        kind: 'test',
        title: 'Test task',
        steps: Array.from({ length: count }, () => ({
          type: 'send_sms_batch',
          approvalClass: 'message' as const,
          payload: {},
          preview: {},
        })),
      },
      t0,
    );
    const steps = await listSteps(tx, ctx, [taskId]);
    return { taskId, stepIds: steps.map((s) => s.id) };
  });
}

describe('agent events', () => {
  test('insertAgentEvent then listTaskEvents returns events in order', async () => {
    const ctx = ctxFor(seed.a);
    const { taskId } = await makeTask(seed.a);
    await withTenant(pools, ctx, async (tx) => {
      await insertAgentEvent(tx, ctx, { taskId, kind: 'created', actorType: 'agent', at: new Date('2026-10-12T10:00:00Z') });
      await insertAgentEvent(tx, ctx, {
        taskId,
        kind: 'approved',
        actorType: 'user',
        actorUserId: seed.a.owner.userId,
        data: { approvedSteps: 1, totalSteps: 1 },
        at: new Date('2026-10-12T10:05:00Z'),
      });
    });
    const events = await withTenant(pools, ctx, (tx) => listTaskEvents(tx, ctx, taskId));
    expect(events.map((e) => e.kind)).toEqual(['created', 'approved']);
    expect(events[0]).toMatchObject({ actorType: 'agent', actorUserId: null, stepId: null, data: {} });
    expect(events[1]).toMatchObject({ actorType: 'user', actorUserId: seed.a.owner.userId, data: { approvedSteps: 1, totalSteps: 1 } });

    const recent = await withTenant(pools, ctx, (tx) => listRecentEvents(tx, ctx, { limit: 1 }));
    expect(recent.map((e) => e.kind)).toEqual(['approved']);
  });

  test('another company sees none of them', async () => {
    const ctx = ctxFor(seed.a);
    const { taskId } = await makeTask(seed.a);
    await withTenant(pools, ctx, (tx) => insertAgentEvent(tx, ctx, { taskId, kind: 'created', actorType: 'system', at: t0 }));
    const other = ctxFor(seed.b);
    expect(await withTenant(pools, other, (tx) => listRecentEvents(tx, other))).toEqual([]);
  });
});

describe('loadBaselineOverrides', () => {
  test('empty with no rows, picks up a visible key, ignores hidden keys', async () => {
    const ctx = ctxFor(seed.a);
    expect(await withTenant(pools, ctx, (tx) => loadBaselineOverrides(tx, ctx))).toEqual({});

    await withTenant(pools, ctx, (tx) =>
      tx.insert(timeBaselines).values([
        { companyId: ctx.companyId, key: 'text_sent', minutesPerUnit: 2 },
        { companyId: ctx.companyId, key: 'demo', minutesPerUnit: 9 },
      ]),
    );
    expect(await withTenant(pools, ctx, (tx) => loadBaselineOverrides(tx, ctx))).toEqual({ text_sent: 2 });
  });
});

describe('step snapshots', () => {
  test('setStepSnapshot rounds to 2 decimals; the sum counts only done steps', async () => {
    const ctx = ctxFor(seed.a);
    const { taskId, stepIds } = await makeTask(seed.a, 2);
    await withTenant(pools, ctx, async (tx) => {
      await setStepSnapshot(
        tx,
        ctx,
        stepIds[0]!,
        { baselineKey: 'text_sent', units: 3.456, minutesPerUnit: 1.005, minutesSaved: 10.376 },
        t0,
      );
      await setStepSnapshot(tx, ctx, stepIds[1]!, { baselineKey: 'text_sent', units: 1, minutesPerUnit: 4, minutesSaved: 4 }, t0);
      await tx.update(agentTaskSteps).set({ status: 'done' }).where(eq(agentTaskSteps.id, stepIds[0]!));
    });
    const steps = await withTenant(pools, ctx, (tx) => listSteps(tx, ctx, [taskId]));
    expect(steps[0]).toMatchObject({ baselineKey: 'text_sent', units: 3.46, minutesSaved: 10.38 });
    expect([1, 1.01]).toContain(steps[0]!.minutesPerUnit);
    expect(await withTenant(pools, ctx, (tx) => sumStepMinutesSaved(tx, ctx, taskId))).toBe(10.38);
  });

  test('sumStepMinutesSaved is 0 with nothing done', async () => {
    const ctx = ctxFor(seed.a);
    const { taskId } = await makeTask(seed.a);
    expect(await withTenant(pools, ctx, (tx) => sumStepMinutesSaved(tx, ctx, taskId))).toBe(0);
  });
});

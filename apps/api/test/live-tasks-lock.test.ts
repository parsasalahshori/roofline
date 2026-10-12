import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { agentTaskSteps } from '@roofline/db';
import { addToLiveTask, createLiveTask } from '../src/tasks/service.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const NOW = new Date('2026-10-12T15:00:00.000Z');

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
});

const companyId = () => t.seed.a.companyId;
const ctx = () => ({ companyId: companyId(), userId: null, role: 'system' as const, canApproveSpend: false });

describe('addToLiveTask locking', () => {
  test('two concurrent repeats on one key both count (step row locked)', async () => {
    const idempotencyKey = `fd-texts:${randomUUID()}:2026-10-12`;
    const { taskId } = await inCompany(t, companyId(), (tx) =>
      createLiveTask(
        tx,
        ctx(),
        {
          agent: 'front_desk',
          kind: 'text_conversation',
          title: 'Answered texts',
          subjectType: 'job',
          subjectId: randomUUID(),
          step: { type: 'front_desk_texts', result: { replies: 1, bookings: 0 } },
          status: 'done',
          idempotencyKey,
        },
        t.clock.now(),
      ),
    );

    // Each repeat runs in its own transaction, at the same time.
    await Promise.all([
      inCompany(t, companyId(), (tx) => addToLiveTask(tx, ctx(), idempotencyKey, { replies: 1, bookings: 0 }, t.clock.now())),
      inCompany(t, companyId(), (tx) => addToLiveTask(tx, ctx(), idempotencyKey, { replies: 1, bookings: 0 }, t.clock.now())),
    ]);

    const steps = await inCompany(t, companyId(), (tx) => tx.select().from(agentTaskSteps).where(eq(agentTaskSteps.taskId, taskId)));
    expect(steps).toHaveLength(1);
    expect((steps[0]!.result as { replies: number }).replies).toBe(3);
  });
});

import { beforeEach, describe, expect, test } from 'vitest';
import { conversations } from '@roofline/db';
import type { AgentsOverview } from '@roofline/shared';
import { createLiveTask } from '../src/tasks/service.ts';
import { Actors, addressFor, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * A1 Task 22: a job with an open live Front Desk task and a message conversation is ONE waiting item and counts 1.
 * Database-backed: CI runs it.
 */

const NOW = new Date('2026-10-12T15:00:00.000Z');

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  who = new Actors(t);
});

describe('Front Desk follow-up counted once', () => {
  test('a job with an open live task and a message conversation is one waiting item and waitingCount 1', async () => {
    const companyId = t.seed.a.companyId;
    const owner = await who.as('owner');
    const customer = await mustCreate(owner, '/api/customers', { displayName: 'Nina Customer' });
    const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(31) });
    const job = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id, nextStep: 'Call Nina back' });

    await inCompany(t, companyId, async (tx) => {
      await tx.insert(conversations).values({
        companyId,
        channel: 'voice',
        customerId: customer.id,
        phoneE164: '+14025550999',
        companyNumberE164: '+14025550100',
        status: 'ended',
        outcome: 'message',
        lastMessageAt: t.clock.now(),
      });
      await createLiveTask(
        tx,
        { companyId, userId: null, role: 'system', canApproveSpend: false },
        {
          agent: 'front_desk',
          kind: 'call',
          title: 'Took a message',
          subjectType: 'job',
          subjectId: job.id,
          step: { type: 'front_desk_call', result: { seconds: 30, bookings: 0, spam: 0 } },
          status: 'needs_attention',
          idempotencyKey: 'fd-call:test-1',
        },
        t.clock.now(),
      );
    });

    const waiting = await owner.get('/api/agents/waiting');
    expect(waiting.status).toBe(200);
    const items = (waiting.body.items as { id: string; href: string | null }[]).filter((i) => i.href === `/jobs/${job.id}`);
    expect(items).toHaveLength(1);
    expect(items.some((i) => i.id === `fd-follow-up:${job.id}`)).toBe(false);

    const cards = await owner.get('/api/agents');
    expect(cards.status).toBe(200);
    expect((cards.body as AgentsOverview).cards.find((c) => c.agent === 'front_desk')!.waitingCount).toBe(1);
  });
});

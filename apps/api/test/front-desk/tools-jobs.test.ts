import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAppointment, createCustomer, createJob, createProperty, withTenant } from '@roofline/db';
import type { ConversationState, ToolContext } from '../../src/front-desk/engine-types.ts';
import { newConversationState } from '../../src/front-desk/state.ts';
import { hailAtMyHome } from '../../src/front-desk/tools/hail.ts';
import { lookupMyJobs } from '../../src/front-desk/tools/jobs.ts';
import { makeTestApp } from '../helpers.ts';

const hailMock = vi.hoisted(() => ({ hits: [] as { propertyId: string; occurredOn: string; hailSizeInches: number | null }[] }));
vi.mock('@roofline/db', async (orig) => {
  const real = await orig<typeof import('@roofline/db')>();
  return { ...real, hailHitsForProperties: vi.fn(async () => hailMock.hits) };
});

afterEach(() => {
  hailMock.hits = [];
});

async function setup() {
  const t = await makeTestApp();
  const companyId = t.seed.a.companyId;
  const ctx = { companyId, userId: t.seed.a.owner.userId, role: 'owner' as const, canApproveSpend: true };
  const now = new Date();
  const ids = await withTenant(t.deps.pools, ctx, async (tx) => {
    const customer = await createCustomer(tx, ctx, { displayName: 'Pat Doe', phones: [{ e164: '+14025550111' }] }, { now });
    const property = await createProperty(
      tx,
      ctx,
      { customerId: customer.id, addressLine: '123 Elm St', city: 'Omaha', state: 'NE', zip: '68102' },
      { now },
    );
    const job = await createJob(tx, ctx, { customerId: customer.id, propertyId: property.id }, { now });
    const starts = new Date(now.getTime() + 3 * 86_400_000);
    await createAppointment(
      tx,
      ctx,
      { kind: 'inspection', jobId: job.id, customerId: customer.id, propertyId: property.id, startsAt: starts, endsAt: new Date(starts.getTime() + 3_600_000) },
      now,
    );
    return { customerId: customer.id, propertyId: property.id, jobId: job.id, starts };
  });
  const conversation: ConversationState = {
    ...newConversationState({
      companyId,
      conversationId: '00000000-0000-4000-8000-000000000001',
      channel: 'voice',
      phone: '+14025550111',
      callId: null,
      companyBlock: '',
      repName: null,
      startedAt: now,
    }),
    customerId: ids.customerId,
  };
  const tool = (identity: ConversationState['identity']): ToolContext => ({
    deps: t.deps,
    companyId,
    conversation: { ...conversation, identity },
    now,
  });
  return { t, ids, tool, conversation };
}

describe('lookup_my_jobs', () => {
  test('a phone-matched caller hears only the weekday of the next appointment', async () => {
    const { tool } = await setup();
    const r = await lookupMyJobs(tool('matched'), {});
    expect(r.ok).toBe(true);
    expect(r.forModel).toMatch(/^You have an appointment on (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\.$/);
    expect(r.forModel).not.toMatch(/Elm|\d/);
    expect(r.shownIds).toBeUndefined();
  });

  test('a verified caller gets stage words, the street and the next visit', async () => {
    const { tool, ids } = await setup();
    const r = await lookupMyJobs(tool('verified'), {});
    expect(r.ok).toBe(true);
    expect(r.forModel).toContain(`Job ${ids.jobId} at 123 Elm St`);
    expect(r.forModel).toContain('inspection stage');
    expect(r.forModel).toMatch(/Next: (inspection or )?visit on /);
    expect(r.shownIds).toEqual([ids.jobId]);
  });

  test('no customer is a plain refusal', async () => {
    const { tool, conversation } = await setup();
    conversation.customerId = null;
    const r = await lookupMyJobs(tool('verified'), {});
    expect(r.ok).toBe(false);
  });
});

describe('hail_at_my_home', () => {
  test('needs verification', async () => {
    const { tool } = await setup();
    const r = await hailAtMyHome(tool('matched'), { propertyId: null });
    expect(r.ok).toBe(false);
    expect(r.forModel).toMatch(/verify/i);
  });

  test('with no records it says so and claims nothing about damage', async () => {
    const { tool, ids } = await setup();
    const r = await hailAtMyHome(tool('verified'), { propertyId: null });
    expect(r.ok).toBe(true);
    expect(r.forModel).toMatch(/no hail record/i);
    expect(r.forModel).toMatch(/does not mean there was or was not damage/i);
    expect(r.shownIds).toEqual([ids.propertyId]);
  });

  test('a hit is phrased as radar-estimated', async () => {
    const { tool, ids } = await setup();
    hailMock.hits = [{ propertyId: ids.propertyId, occurredOn: '2026-10-03', hailSizeInches: 1.5 }];
    const r = await hailAtMyHome(tool('verified'), { propertyId: null });
    expect(r.forModel).toMatch(/radar-estimated/i);
    expect(r.forModel).toContain('123 Elm St');
    expect(r.forModel).toContain('Oct 3');
  });

  test('a property id the model was not shown is refused', async () => {
    const { tool, ids } = await setup();
    const r = await hailAtMyHome(tool('verified'), { propertyId: ids.propertyId });
    expect(r.ok).toBe(false);
  });
});

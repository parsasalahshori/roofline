import { describe, expect, test } from 'vitest';
import { createCustomer, createJob, createProperty, withTenant } from '@roofline/db';
import type { ConversationState, ToolContext } from '../../src/front-desk/engine-types.ts';
import { newConversationState } from '../../src/front-desk/state.ts';
import { checkForecast } from '../../src/front-desk/tools/forecast.ts';
import { lookupMyJobs } from '../../src/front-desk/tools/jobs.ts';
import { makeTestApp } from '../helpers.ts';

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
      { customerId: customer.id, addressLine: '123 Elm St', city: 'Omaha', state: 'NE', zip: '68102', location: [-95.93, 41.25] },
      { now },
    );
    return { customerId: customer.id, propertyId: property.id };
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
    identity: 'verified',
  };
  const tool = (shown: string[] = []): ToolContext => ({
    deps: t.deps,
    companyId,
    conversation: { ...conversation, shownIds: new Set(shown) },
    now,
  });
  return { t, ids, tool };
}

describe('check_forecast', () => {
  test('no forecast: says it cannot reach it', async () => {
    const { t, ids, tool } = await setup();
    t.weather.dailyValue = null;
    const r = await checkForecast(tool([ids.propertyId]), { date: '2026-10-15', propertyId: ids.propertyId });
    expect(r.ok).toBe(false);
    expect(r.forModel).toContain("I can't reach the forecast right now");
  });

  test('a day with no entry is the same answer', async () => {
    const { t, ids, tool } = await setup();
    t.weather.dailyValue = [{ date: '2026-10-16', highF: 60, lowF: 40, summary: 'Sunny', precipChancePercent: 0 }];
    const r = await checkForecast(tool([ids.propertyId]), { date: '2026-10-15', propertyId: ids.propertyId });
    expect(r.ok).toBe(false);
    expect(r.forModel).toContain("I can't reach the forecast right now");
  });

  test('success is one plain sentence with the high', async () => {
    const { t, ids, tool } = await setup();
    t.weather.dailyValue = [{ date: '2026-10-15', highF: 72, lowF: 55, summary: 'Mostly Sunny', precipChancePercent: 10 }];
    const r = await checkForecast(tool([ids.propertyId]), { date: '2026-10-15', propertyId: ids.propertyId });
    expect(r.ok).toBe(true);
    expect(r.forModel).toBe('Forecast for Thursday Oct 15: mostly sunny, high 72, low 55, 10 percent chance of rain.');
    expect(t.weather.dailyCalls).toHaveLength(1);
  });

  test('a property id taken from lookup_my_jobs shownIds is accepted', async () => {
    const { t, ids, tool } = await setup();
    t.weather.dailyValue = [{ date: '2026-10-15', highF: 72, lowF: 55, summary: 'Sunny', precipChancePercent: 0 }];
    const ownCtx = { companyId: t.seed.a.companyId, userId: t.seed.a.owner.userId, role: 'owner' as const, canApproveSpend: true };
    const jobId = await withTenant(t.deps.pools, ownCtx, async (tx) => {
      const job = await createJob(tx, ownCtx, { customerId: ids.customerId, propertyId: ids.propertyId }, { now: new Date() });
      return job.id;
    });
    expect(jobId).toBeTruthy();
    const listed = await lookupMyJobs(tool(), {});
    expect(listed.shownIds).toContain(ids.propertyId);
    const r = await checkForecast(tool(listed.shownIds ?? []), { date: '2026-10-15', propertyId: ids.propertyId });
    expect(r.ok).toBe(true);
    expect(t.weather.dailyCalls).toHaveLength(1);
  });

  test('a property id that was not shown is rejected', async () => {
    const { t, ids, tool } = await setup();
    t.weather.dailyValue = [{ date: '2026-10-15', highF: 72, lowF: 55, summary: 'Sunny', precipChancePercent: 0 }];
    const r = await checkForecast(tool([]), { date: '2026-10-15', propertyId: ids.propertyId });
    expect(r.ok).toBe(false);
    expect(t.weather.dailyCalls).toHaveLength(0);
  });
});

import { companySettings } from '@roofline/db';
import { rulesFor } from '@roofline/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { gatherRuleFacts } from '../src/agents/rule-facts.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

const systemCtx = (companyId: string) => ({ companyId, userId: null, role: 'owner' as const, canApproveSpend: true });

const factsFor = (companyId: string) => inCompany(t, companyId, (tx) => gatherRuleFacts(tx, systemCtx(companyId)));

const DEFAULTS = { thresholdInches: 1, budgetCents: 27000, days: 7 };

describe('gatherRuleFacts (A1 Tasks 5 and 14)', () => {
  test('a default company gets the Storm Scout defaults and no Front Desk facts', async () => {
    const facts = await factsFor(t.seed.a.companyId);
    expect(facts.stormScout).toEqual(DEFAULTS);
    expect(facts).not.toHaveProperty('frontDesk');
  });

  test('changed company settings flow into the Storm Scout facts', async () => {
    const companyId = t.seed.a.companyId;
    await inCompany(t, companyId, async (tx) => {
      const updated = await tx
        .update(companySettings)
        .set({ hailThresholdIn: 1.5, stormAdBudgetCents: 50000, stormAdDays: 3 })
        .where(eq(companySettings.companyId, companyId))
        .returning({ companyId: companySettings.companyId });
      if (updated.length === 0) {
        await tx.insert(companySettings).values({ companyId, hailThresholdIn: 1.5, stormAdBudgetCents: 50000, stormAdDays: 3 });
      }
    });
    expect(await factsFor(companyId)).toEqual({ stormScout: { thresholdInches: 1.5, budgetCents: 50000, days: 3 } });
  });

  test('company B is unaffected by company A settings', async () => {
    const aId = t.seed.a.companyId;
    await inCompany(t, aId, async (tx) => {
      await tx
        .update(companySettings)
        .set({ hailThresholdIn: 2, stormAdBudgetCents: 90000, stormAdDays: 2 })
        .where(eq(companySettings.companyId, aId));
    });
    const facts = await factsFor(t.seed.b.companyId);
    expect(facts.stormScout).toEqual(DEFAULTS);
  });

  test('rulesFor gives Storm Scout one sentence with three settings links and Front Desk none', async () => {
    const facts = await factsFor(t.seed.a.companyId);
    const storm = rulesFor('storm_scout', facts);
    expect(storm).toHaveLength(1);
    expect(storm[0]!.links).toHaveLength(3);
    expect(storm[0]!.links.every((l) => l.href === '/settings/storm')).toBe(true);
    expect(rulesFor('front_desk', facts)).toEqual([]);
  });

  test('a rep gets no ad budget and no links; an owner gets the number and no noLinks', async () => {
    const companyId = t.seed.a.companyId;
    const repCtx = { companyId, userId: null, role: 'rep' as const, canApproveSpend: false };
    const ownerCtx = { ...repCtx, role: 'owner' as const };
    const rep = await inCompany(t, companyId, (tx) => gatherRuleFacts(tx, repCtx));
    expect(rep.stormScout?.budgetCents).toBeNull();
    expect(rep.noLinks).toBe(true);
    const owner = await inCompany(t, companyId, (tx) => gatherRuleFacts(tx, ownerCtx));
    expect(owner.stormScout?.budgetCents).toBe(27000);
    expect(owner).not.toHaveProperty('noLinks');
  });
});

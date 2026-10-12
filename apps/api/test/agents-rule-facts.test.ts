import { companyPhoneNumbers, companySettings } from '@roofline/db';
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
    expect((await factsFor(companyId)).stormScout).toEqual({ thresholdInches: 1.5, budgetCents: 50000, days: 3 });
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

  test('Front Desk facts: number, what it may do, and the first rule sentence (transfer names wait for the view)', async () => {
    const companyId = t.seed.a.companyId;
    await t.deps.pools.system
      .insert(companyPhoneNumbers)
      .values({ companyId, e164: '+19495550100', capabilities: ['sms', 'voice'], providerSid: 'PN_RF' });
    for (const canMove of [false, true]) {
      await inCompany(t, companyId, async (tx) => {
        const updated = await tx
          .update(companySettings)
          .set({ frontDeskEnabled: true, frontDeskCanMove: canMove })
          .where(eq(companySettings.companyId, companyId))
          .returning({ companyId: companySettings.companyId });
        if (updated.length === 0) await tx.insert(companySettings).values({ companyId, frontDeskEnabled: true, frontDeskCanMove: canMove });
      });
      const facts = await factsFor(companyId);
      // company_members does not expose transfer_phone_e164 / on_call_order, so the names are empty (no migration).
      expect(facts.frontDesk).toEqual({ phoneNumber: '(949) 555-0100', transferNames: [], canBook: true, canConfirm: true, canMove });
      const rules = rulesFor('front_desk', facts);
      expect(rules[0]!.text).toContain('(949) 555-0100');
      expect(rules[0]!.links.every((l) => l.href === '/settings/front-desk')).toBe(true);
    }
  });

  test('a rep gets the Front Desk sentences with no links', async () => {
    const companyId = t.seed.a.companyId;
    await t.deps.pools.system
      .insert(companyPhoneNumbers)
      .values({ companyId, e164: '+19495550100', capabilities: ['voice'], providerSid: 'PN_RF2' });
    await inCompany(t, companyId, async (tx) => {
      const updated = await tx
        .update(companySettings)
        .set({ frontDeskEnabled: true })
        .where(eq(companySettings.companyId, companyId))
        .returning({ companyId: companySettings.companyId });
      if (updated.length === 0) await tx.insert(companySettings).values({ companyId, frontDeskEnabled: true });
    });
    const repCtx = { companyId, userId: null, role: 'rep' as const, canApproveSpend: false };
    const facts = await inCompany(t, companyId, (tx) => gatherRuleFacts(tx, repCtx));
    const rules = rulesFor('front_desk', facts);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => r.links.length === 0)).toBe(true);
  });

  test('Front Desk off with an active voice number gives no Front Desk facts', async () => {
    const companyId = t.seed.a.companyId;
    await t.deps.pools.system
      .insert(companyPhoneNumbers)
      .values({ companyId, e164: '+19495550100', capabilities: ['voice'], providerSid: 'PN_RF3' });
    const facts = await factsFor(companyId);
    expect(facts).not.toHaveProperty('frontDesk');
    expect(rulesFor('front_desk', facts)).toEqual([]);
  });
});

describe('gatherRuleFacts (G1 Task 15)', () => {
  test('gatherRuleFacts fills the three G1 fields with the default settings', async () => {
    const facts = await inCompany(t, t.seed.a.companyId, (tx) => gatherRuleFacts(tx, systemCtx(t.seed.a.companyId)));
    expect(facts).toMatchObject({
      claims: { nudgeDays: [3, 5, 7] },
      scheduler: { reminderHour: 15, rainPct: 60, gustMph: 25 },
      followUp: {
        proposalDays: [3, 4],
        leadDays: 2,
        reviewDelayDays: 3,
        reviewsOn: false,
        leadsOn: true,
        proposalsOn: true,
      },
    });
  });

  test('gatherRuleFacts reflects changed settings and a saved review link', async () => {
    const companyId = t.seed.a.companyId;
    await inCompany(t, companyId, (tx) =>
      tx
        .update(companySettings)
        .set({
          claimsNudgeDays: [2, 4, 6],
          reminderHour: 16,
          weatherRainPct: 40,
          weatherGustMph: 30,
          followupDays: [1, 5],
          leadFollowupDays: 4,
          reviewDelayDays: 1,
          reviewLink: 'https://example.com/review',
          followupLeads: false,
        })
        .where(eq(companySettings.companyId, companyId)),
    );
    const facts = await inCompany(t, companyId, (tx) => gatherRuleFacts(tx, systemCtx(companyId)));
    expect(facts.claims).toEqual({ nudgeDays: [2, 4, 6] });
    expect(facts.scheduler).toEqual({ reminderHour: 16, rainPct: 40, gustMph: 30 });
    expect(facts.followUp).toEqual({
      proposalDays: [1, 5],
      leadDays: 4,
      reviewDelayDays: 1,
      reviewsOn: true,
      leadsOn: false,
      proposalsOn: true,
    });
    const other = await inCompany(t, t.seed.b.companyId, (tx) => gatherRuleFacts(tx, systemCtx(t.seed.b.companyId)));
    expect(other.claims).toEqual({ nudgeDays: [3, 5, 7] });
  });

  test('rulesFor gives the three G1 agents their sentences from the gathered facts', async () => {
    const facts = await inCompany(t, t.seed.a.companyId, (tx) => gatherRuleFacts(tx, systemCtx(t.seed.a.companyId)));
    expect(rulesFor('claims', facts)).toHaveLength(2);
    expect(rulesFor('scheduler', facts)).toHaveLength(4);
    expect(rulesFor('follow_up', facts).map((r) => r.text)).toContain('Reviews are off until you add your review link.');
  });
});

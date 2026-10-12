import { companyPhoneNumbers, companySettings, memberships, users } from '@roofline/db';
import { onCallFirstNames } from '@roofline/db/system';
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

  test('Front Desk facts: number, what it may do, and the first rule sentence (no names passed: none)', async () => {
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
      expect(facts.frontDesk).toEqual({ phoneNumber: '(949) 555-0100', transferNames: [], canBook: true, canConfirm: true, canMove, canCancel: true });
      const rules = rulesFor('front_desk', facts);
      expect(rules[0]!.text).toContain('(949) 555-0100');
      expect(rules[0]!.links.every((l) => l.href === '/settings/front-desk')).toBe(true);
    }
  });

  test('transferNames are the names the caller passes, and the rule sentences name them and cancelling', async () => {
    const companyId = t.seed.a.companyId;
    await t.deps.pools.system
      .insert(companyPhoneNumbers)
      .values({ companyId, e164: '+19495550100', capabilities: ['voice'], providerSid: 'PN_RF4' });
    await inCompany(t, companyId, async (tx) => {
      const updated = await tx
        .update(companySettings)
        .set({ frontDeskEnabled: true })
        .where(eq(companySettings.companyId, companyId))
        .returning({ companyId: companySettings.companyId });
      if (updated.length === 0) await tx.insert(companySettings).values({ companyId, frontDeskEnabled: true });
    });
    const facts = await inCompany(t, companyId, (tx) => gatherRuleFacts(tx, systemCtx(companyId), ['Sam', 'Pat']));
    expect(facts.frontDesk?.transferNames).toEqual(['Sam', 'Pat']);
    expect(facts.frontDesk?.canCancel).toBe(true);
    const texts = rulesFor('front_desk', facts).map((r) => r.text);
    expect(texts).toContain('I can cancel appointments when a customer asks.');
    expect(texts).toContain('I transfer urgent calls to Sam, then Pat.');
  });

  test('onCallFirstNames: first names of active on-call members in order; no phone, no order or inactive are left out', async () => {
    const companyId = t.seed.a.companyId;
    const sys = t.deps.pools.system;
    const mk = async (name: string, email: string, m: { phone: string | null; order: number | null; status?: 'active' | 'disabled' }) => {
      const [u] = await sys.insert(users).values({ email, name }).returning({ id: users.id });
      await sys.insert(memberships).values({
        companyId,
        userId: u!.id,
        role: 'office',
        status: m.status ?? 'active',
        transferPhoneE164: m.phone,
        onCallOrder: m.order,
      });
    };
    await mk('Pat Second', 'pat@example.test', { phone: '+14025550102', order: 2 });
    await mk('  Sam   First', 'sam@example.test', { phone: '+14025550101', order: 1 });
    await mk('No Phone', 'nophone@example.test', { phone: null, order: 3 });
    await mk('No Order', 'noorder@example.test', { phone: '+14025550103', order: null });
    await mk('Gone Away', 'gone@example.test', { phone: '+14025550104', order: 4, status: 'disabled' });
    expect(await onCallFirstNames(sys, companyId)).toEqual(['Sam', 'Pat']);
    expect(await onCallFirstNames(sys, t.seed.b.companyId)).toEqual([]);
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

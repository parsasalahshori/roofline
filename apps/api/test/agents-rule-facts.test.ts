import { eq } from 'drizzle-orm';
import { companySettings } from '@roofline/db';
import { rulesFor } from '@roofline/shared';
import { beforeEach, describe, expect, test } from 'vitest';
import { gatherRuleFacts } from '../src/agents/rule-facts.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

const systemCtx = (companyId: string) => ({ companyId, userId: null, role: 'system' as const, canApproveSpend: false });

describe('gatherRuleFacts (A1 Task 5)', () => {
  test('gatherRuleFacts fills the three G1 fields with the default settings and leaves storm and front desk out', async () => {
    const facts = await inCompany(t, t.seed.a.companyId, (tx) => gatherRuleFacts(tx, systemCtx(t.seed.a.companyId)));
    expect(facts).toEqual({
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

  test('rulesFor gives the Estimator sentence only', () => {
    const facts = {};
    const estimator = rulesFor('estimator', facts);
    expect(estimator).toHaveLength(1);
    expect(estimator[0]!.text.startsWith('When you type an address')).toBe(true);
    expect(rulesFor('storm_scout', facts)).toEqual([]);
    expect(rulesFor('front_desk', facts)).toEqual([]);
  });
});

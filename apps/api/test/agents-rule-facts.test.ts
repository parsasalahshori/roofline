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
  test('gatherRuleFacts has no storm or front desk facts on this base', async () => {
    const facts = await inCompany(t, t.seed.a.companyId, (tx) => gatherRuleFacts(tx, systemCtx(t.seed.a.companyId)));
    expect(facts).toEqual({});
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

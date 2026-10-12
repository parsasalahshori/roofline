import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { createPools } from '../src/pools.ts';
import { insertConversation } from '../src/repos/conversations.ts';
import { loadStoredIdentity, loadTurnStats, saveCallerIdentity } from '../src/repos/conversation-identity.ts';
import { insertTurn } from '../src/repos/turns.ts';
import { customers } from '../src/schema/index.ts';
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

function newConversation(c: SeededCompany): Promise<string> {
  return withTenant(pools, ctxFor(c), async (tx) => {
    const { id } = await insertConversation(tx, ctxFor(c), {
      channel: 'sms',
      phoneE164: '+14025550111',
      companyNumberE164: c.phoneE164,
    });
    return id;
  });
}

function seedCustomer(c: SeededCompany): Promise<string> {
  return withTenant(pools, ctxFor(c), async (tx) => {
    const [row] = await tx.insert(customers).values({ companyId: c.companyId, displayName: 'Pat Caller' }).returning({ id: customers.id });
    return row!.id;
  });
}

describe('conversation identity repo', () => {
  test('loadStoredIdentity returns unknown, null customer, 0 failures for a new conversation', async () => {
    const id = await newConversation(seed.a);
    const c = ctxFor(seed.a);
    expect(await withTenant(pools, c, (tx) => loadStoredIdentity(tx, c, id))).toEqual({ identity: 'unknown', customerId: null, verifyFailures: 0 });
  });

  test('saveCallerIdentity writes identity and customer_id (a seeded customer)', async () => {
    const id = await newConversation(seed.a);
    const c = ctxFor(seed.a);
    const customerId = await seedCustomer(seed.a);
    await withTenant(pools, c, (tx) => saveCallerIdentity(tx, c, id, { identity: 'verified', customerId }));
    expect(await withTenant(pools, c, (tx) => loadStoredIdentity(tx, c, id))).toMatchObject({ identity: 'verified', customerId });
  });

  test('loadStoredIdentity counts only failed verify_caller tool calls', async () => {
    const id = await newConversation(seed.a);
    const c = ctxFor(seed.a);
    await withTenant(pools, c, async (tx) => {
      await insertTurn(tx, c, { conversationId: id, speaker: 'caller', text: 'hi' });
      await insertTurn(tx, c, {
        conversationId: id,
        speaker: 'assistant',
        text: 'checking',
        toolCalls: [
          { name: 'verify_caller', input: {}, result: 'x', ok: false },
          { name: 'verify_caller', input: {}, result: 'x', ok: true },
          { name: 'find_job', input: {}, result: 'x', ok: false },
        ],
      });
    });
    const got = await withTenant(pools, c, (tx) => loadStoredIdentity(tx, c, id));
    expect(got?.verifyFailures).toBe(1);
  });

  test('loadTurnStats on 3 exchanges (caller+assistant each) gives nextPosition 6, callerTurns 3, assistantTurns 3', async () => {
    const id = await newConversation(seed.a);
    const c = ctxFor(seed.a);
    for (let n = 0; n < 3; n += 1) {
      await withTenant(pools, c, async (tx) => {
        await insertTurn(tx, c, { conversationId: id, speaker: 'caller', text: 'q' });
        await insertTurn(tx, c, { conversationId: id, speaker: 'assistant', text: 'a' });
      });
    }
    expect(await withTenant(pools, c, (tx) => loadTurnStats(tx, c, id))).toEqual({ nextPosition: 6, callerTurns: 3, assistantTurns: 3 });
  });

  test('loadTurnStats on an empty conversation gives nextPosition 0', async () => {
    const id = await newConversation(seed.a);
    const c = ctxFor(seed.a);
    expect(await withTenant(pools, c, (tx) => loadTurnStats(tx, c, id))).toEqual({ nextPosition: 0, callerTurns: 0, assistantTurns: 0 });
  });

  test('another company cannot read or write the identity', async () => {
    const id = await newConversation(seed.a);
    const a = ctxFor(seed.a);
    const b = ctxFor(seed.b);
    expect(await withTenant(pools, b, (tx) => loadStoredIdentity(tx, b, id))).toBeNull();
    await withTenant(pools, b, (tx) => saveCallerIdentity(tx, b, id, { identity: 'verified', customerId: null }));
    expect(await withTenant(pools, a, (tx) => loadStoredIdentity(tx, a, id))).toMatchObject({ identity: 'unknown' });
  });
});

import { beforeEach, describe, expect, test } from 'vitest';
import { conversations, customers, getConversation, properties, withTenant, type TenantContext } from '@roofline/db';
import { normalizeAddressKey, VERIFY_MISMATCH_PREFIX } from '@roofline/shared';
import type { ToolContext } from '../../src/front-desk/engine-types.ts';
import { newConversationState } from '../../src/front-desk/state.ts';
import { identifyCaller, VERIFY_LOCKED, verifyCaller } from '../../src/front-desk/tools/caller.ts';
import { inCompany } from '../crm-helpers.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';

/*
 * D1 Task 7: identifyCaller and verifyCaller against the real database. Nothing leaves the process.
 */

let t: TestApp;
const PHONE = '+14025550142';
const A = () => t.seed.a.companyId;
const B = () => t.seed.b.companyId;

beforeEach(async () => {
  t = await makeTestApp();
});

async function addCustomer(companyId: string, displayName: string, phone: string | null, street?: string): Promise<string> {
  return inCompany(t, companyId, async (tx) => {
    const [c] = await tx
      .insert(customers)
      .values({ companyId, displayName, phones: phone ? [{ e164: phone, primary: true }] : [] })
      .returning({ id: customers.id });
    if (street) {
      await tx.insert(properties).values({
        companyId,
        customerId: c!.id,
        addressLine: street,
        city: 'Omaha',
        state: 'NE',
        zip: '68102',
        addressKey: normalizeAddressKey(street, '68102'),
      });
    }
    return c!.id;
  });
}

function ctxFor(companyId: string, phone = PHONE): ToolContext {
  const conversation = newConversationState({
    companyId,
    conversationId: '00000000-0000-4000-8000-000000000001',
    channel: 'voice',
    phone,
    callId: null,
    companyBlock: '',
    repName: null,
    startedAt: new Date('2026-10-12T15:00:00Z'),
  });
  return { deps: t.deps, companyId, conversation, now: new Date('2026-10-12T15:00:00Z') };
}

async function realConversation(ctx: ToolContext): Promise<void> {
  const id = await inCompany(t, ctx.companyId, async (tx) => {
    const [row] = await tx
      .insert(conversations)
      .values({ companyId: ctx.companyId, channel: 'voice', phoneE164: PHONE, companyNumberE164: '+14025550100', status: 'active' })
      .returning({ id: conversations.id });
    return row!.id;
  });
  ctx.conversation.conversationId = id;
}

async function readRow(ctx: ToolContext) {
  const sys: TenantContext = { companyId: ctx.companyId, userId: null, role: 'system', canApproveSpend: false };
  return withTenant(t.deps.pools, sys, (tx) => getConversation(tx, sys, ctx.conversation.conversationId));
}

describe('identifyCaller', () => {
  test('identifyCaller writes conversations.customer_id and identity', async () => {
    const id = await addCustomer(A(), 'Nina Park', PHONE);
    const ctx = ctxFor(A());
    await realConversation(ctx);
    await identifyCaller(ctx);
    const row = await readRow(ctx);
    expect(row?.customerId).toBe(id);
    expect(row?.identity).toBe('matched');
  });

  test('one match sets the customer and matched', async () => {
    const id = await addCustomer(A(), 'Nina Park', PHONE);
    const ctx = ctxFor(A());
    await identifyCaller(ctx);
    expect(ctx.conversation.customerId).toBe(id);
    expect(ctx.conversation.identity).toBe('matched');
  });

  test('two matches leave the caller unknown', async () => {
    await addCustomer(A(), 'Nina Park', PHONE);
    await addCustomer(A(), 'Omar Park', PHONE);
    const ctx = ctxFor(A());
    await identifyCaller(ctx);
    expect(ctx.conversation.customerId).toBeNull();
    expect(ctx.conversation.identity).toBe('unknown');
  });

  test('no match leaves the caller unknown', async () => {
    await addCustomer(A(), 'Nina Park', '+14025550199');
    const ctx = ctxFor(A());
    await identifyCaller(ctx);
    expect(ctx.conversation.customerId).toBeNull();
    expect(ctx.conversation.identity).toBe('unknown');
  });

  test("another company's customer with the same phone is never matched", async () => {
    await addCustomer(B(), 'Bea Other', PHONE);
    const ctx = ctxFor(A());
    await identifyCaller(ctx);
    expect(ctx.conversation.customerId).toBeNull();
    expect(ctx.conversation.identity).toBe('unknown');
  });
});

describe('verifyCaller', () => {
  test('right name and street verifies', async () => {
    const id = await addCustomer(A(), 'Nina Park', PHONE, '412 Oak St');
    const ctx = ctxFor(A());
    await identifyCaller(ctx);
    const res = await verifyCaller(ctx, { name: '  nina   PARK ', street: '412 oak st.' });
    expect(res.ok).toBe(true);
    expect(ctx.conversation.identity).toBe('verified');
    expect(ctx.conversation.customerId).toBe(id);
  });

  test('wrong street fails without saying which part was wrong', async () => {
    await addCustomer(A(), 'Nina Park', PHONE, '412 Oak St');
    const ctx = ctxFor(A());
    await identifyCaller(ctx);
    const res = await verifyCaller(ctx, { name: 'Nina Park', street: '9 Elm St' });
    expect(res.ok).toBe(false);
    expect(ctx.conversation.identity).toBe('matched');
    expect(res.forModel.toLowerCase()).not.toContain('street was');
    expect(res.forModel.toLowerCase()).not.toContain('name was');
    expect(res.forModel.toLowerCase()).not.toContain('transfer');
  });

  test('three failures suggest a transfer', async () => {
    await addCustomer(A(), 'Nina Park', PHONE, '412 Oak St');
    const ctx = ctxFor(A());
    await identifyCaller(ctx);
    const bad = { name: 'Nina Park', street: '9 Elm St' };
    await verifyCaller(ctx, bad);
    await verifyCaller(ctx, bad);
    const third = await verifyCaller(ctx, bad);
    expect(third.ok).toBe(false);
    expect(third.forModel.toLowerCase()).toContain('transfer');
    expect(third.forModel.startsWith(VERIFY_MISMATCH_PREFIX)).toBe(true);
  });

  test('with two phone matches, either customer can verify', async () => {
    await addCustomer(A(), 'Nina Park', PHONE, '412 Oak St');
    const omar = await addCustomer(A(), 'Omar Park', PHONE, '77 Pine Ave');
    const ctx = ctxFor(A());
    await identifyCaller(ctx);
    const res = await verifyCaller(ctx, { name: 'Omar Park', street: '77 Pine Ave' });
    expect(res.ok).toBe(true);
    expect(ctx.conversation.customerId).toBe(omar);
  });

  test('no customer for the phone fails plainly', async () => {
    const ctx = ctxFor(A());
    const res = await verifyCaller(ctx, { name: 'Nina Park', street: '412 Oak St' });
    expect(res.ok).toBe(false);
    expect(ctx.conversation.identity).toBe('unknown');
  });

  test("another company's customer cannot be verified", async () => {
    await addCustomer(B(), 'Bea Other', PHONE, '5 Birch Rd');
    const ctx = ctxFor(A());
    const res = await verifyCaller(ctx, { name: 'Bea Other', street: '5 Birch Rd' });
    expect(res.ok).toBe(false);
    expect(ctx.conversation.customerId).toBeNull();
  });

  test('a successful verify_caller writes identity verified and customer_id on the conversation row (voice call)', async () => {
    const id = await addCustomer(A(), 'Nina Park', PHONE, '412 Oak St');
    const ctx = ctxFor(A());
    await realConversation(ctx);
    await identifyCaller(ctx);
    const res = await verifyCaller(ctx, { name: 'Nina Park', street: '412 Oak St' });
    expect(res.ok).toBe(true);
    const row = await readRow(ctx);
    expect(row?.identity).toBe('verified');
    expect(row?.customerId).toBe(id);
  });

  test('verify_caller refuses with the locked sentence after 3 failures and does no repo lookup', async () => {
    await addCustomer(A(), 'Nina Park', PHONE, '412 Oak St');
    const ctx = ctxFor(A());
    await identifyCaller(ctx);
    const bad = { name: 'Nina Park', street: '9 Elm St' };
    for (let i = 0; i < 3; i++) await verifyCaller(ctx, bad);
    const res = await verifyCaller(ctx, { name: 'Nina Park', street: '412 Oak St' });
    expect(res).toEqual({ ok: false, forModel: VERIFY_LOCKED });
    expect(ctx.conversation.identity).toBe('matched');
  });

  test('verifyFailures resets to 0 on success', async () => {
    await addCustomer(A(), 'Nina Park', PHONE, '412 Oak St');
    const ctx = ctxFor(A());
    await identifyCaller(ctx);
    await verifyCaller(ctx, { name: 'Nina Park', street: '9 Elm St' });
    expect(ctx.conversation.verifyFailures).toBe(1);
    await verifyCaller(ctx, { name: 'Nina Park', street: '412 Oak St' });
    expect(ctx.conversation.verifyFailures).toBe(0);
  });
});

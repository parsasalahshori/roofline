import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { withTenant, type TenantContext } from '@roofline/db';
import { insertOmahaStorm, type Query } from '@roofline/db/testing';
import { AppError } from '../src/errors.ts';
import { editStep } from '../src/tasks/service.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { dbSteps, newCustomers, newTask, STOP_BODY } from './task-helpers.ts';

/*
 * The editStep guard (S1 whole-branch review): a storm plan's texts and emails stay marketing with the
 * same message key, an ad can be lowered but not raised, and every other task is left alone.
 * Needs Docker; CI only.
 */

const NOW = new Date('2026-10-12T15:00:00.000Z');

const STAY_MARKETING = "Storm texts and emails stay marketing messages, so that can't be changed.";
const KEY_LOCKED = "The message key for a storm plan can't be changed.";
const AD_CEILING = 'You can lower the ad budget or days, but not raise them above what was drafted.';

let owner: pg.Pool;
let t: TestApp;
let companyStormId: string;
let customerId: string;

const q: Query = async (text, values) => (await owner.query(text, values)).rows;
const companyId = () => t.seed.a.companyId;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  const stormId = await insertOmahaStorm(q, '2026-10-11');
  const rows = await q(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit) values ($1, $2, 1.5, 1, 1) returning id`,
    [companyId(), stormId],
  );
  companyStormId = rows[0]!.id as string;
  [customerId] = await newCustomers(t, 'a', ['Maria']);
});

const ownerCtx = (): TenantContext => ({ companyId: companyId(), userId: t.seed.a.owner.userId, role: 'owner', canApproveSpend: true });

const smsPayload = (over: Record<string, unknown> = {}) => ({
  purpose: 'marketing',
  body: STOP_BODY,
  customerIds: [customerId],
  dedupePrefix: `storm:${companyStormId}`,
  ...over,
});
const emailPayload = (over: Record<string, unknown> = {}) => ({
  purpose: 'marketing',
  subject: 'Hail hit your street',
  body: 'Hello {first_name}, hail hit your street. Reply or call us for a free roof check.',
  customerIds: [customerId],
  dedupePrefix: `storm:${companyStormId}`,
  companyStormId,
  ...over,
});
const adPayload = (over: Record<string, unknown> = {}) => ({
  companyStormId,
  platform: 'google',
  maxSpendCents: 27000,
  days: 7,
  headline: 'Hail damage?',
  description: 'Free roof check.',
  keywords: ['roof repair'],
  ...over,
});

/** Makes a one-step task of the given kind and returns a function that edits that step. */
async function stepOf(type: 'send_sms_batch' | 'send_email_batch' | 'create_ad_campaign', payload: unknown, kind = 'storm_plan') {
  const { taskId } = await newTask(t, 'a', { kind, steps: [{ type, payload }] });
  const [step] = await dbSteps(t, 'a', taskId);
  const ctx = ownerCtx();
  return (edit: { payload?: Record<string, unknown>; enabled?: boolean }) =>
    withTenant(t.deps.pools, ctx, (tx) => editStep(tx, ctx, taskId, step!.id, { version: step!.version, ...edit }, { now: NOW }));
}

async function refused(run: Promise<unknown>): Promise<AppError> {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect(err).toMatchObject({ status: 400 });
  return err as AppError;
}

describe('storm plan step edits', () => {
  test('a storm text cannot become informational', async () => {
    const edit = await stepOf('send_sms_batch', smsPayload());
    const err = await refused(edit({ payload: smsPayload({ purpose: 'informational', body: 'Your crew arrives at 8am Tuesday.' }) }));
    expect(err).toMatchObject({ message: STAY_MARKETING, field: 'payload.purpose' });
  });

  test('a storm text cannot lose or change its dedupePrefix', async () => {
    const removed = await stepOf('send_sms_batch', smsPayload());
    const without: Record<string, unknown> = { ...smsPayload() };
    delete without.dedupePrefix;
    expect(await refused(removed({ payload: without }))).toMatchObject({ message: KEY_LOCKED, field: 'payload.dedupePrefix' });
    const changed = await stepOf('send_sms_batch', smsPayload());
    expect(await refused(changed({ payload: smsPayload({ dedupePrefix: 'storm:other' }) }))).toMatchObject({
      field: 'payload.dedupePrefix',
    });
  });

  test('editing the text body or recipients is still allowed', async () => {
    const edit = await stepOf('send_sms_batch', smsPayload());
    const body = "{company} here. Hail hit your street. Free roof check. Reply STOP to opt out.";
    const out = await edit({ payload: smsPayload({ body }) });
    expect(out).toMatchObject({ version: 2, payload: { purpose: 'marketing', body } });
  });

  test('switching a storm step off or on is still allowed', async () => {
    const edit = await stepOf('send_sms_batch', smsPayload());
    expect(await edit({ enabled: false })).toMatchObject({ enabled: false });
  });

  test('a storm email cannot change purpose, dedupePrefix or companyStormId', async () => {
    const purpose = await stepOf('send_email_batch', emailPayload());
    await refused(purpose({ payload: emailPayload({ purpose: "informational" }) }));
    const prefix = await stepOf('send_email_batch', emailPayload());
    expect(await refused(prefix({ payload: emailPayload({ dedupePrefix: 'storm:other' }) }))).toMatchObject({
      field: 'payload.dedupePrefix',
    });
    const removed = await stepOf('send_email_batch', emailPayload());
    const without: Record<string, unknown> = { ...emailPayload() };
    delete without.dedupePrefix;
    expect(await refused(removed({ payload: without }))).toMatchObject({ field: 'payload.dedupePrefix' });
    const storm = await stepOf('send_email_batch', emailPayload());
    const other = '11111111-1111-4111-8111-111111111111';
    expect(await refused(storm({ payload: emailPayload({ companyStormId: other }) }))).toMatchObject({
      field: 'payload.companyStormId',
    });
  });

  test('a storm email body edit is allowed', async () => {
    const edit = await stepOf('send_email_batch', emailPayload());
    const out = await edit({ payload: emailPayload({ subject: 'A new subject' }) });
    expect(out).toMatchObject({ version: 2 });
  });

  test('an ad budget or days cannot be raised, but can be lowered', async () => {
    const spend = await stepOf('create_ad_campaign', adPayload());
    expect(await refused(spend({ payload: adPayload({ maxSpendCents: 27001 }) }))).toMatchObject({
      message: AD_CEILING,
      field: 'payload.maxSpendCents',
    });
    const days = await stepOf('create_ad_campaign', adPayload());
    expect(await refused(days({ payload: adPayload({ days: 8 }) }))).toMatchObject({ message: AD_CEILING, field: 'payload.days' });
    const lower = await stepOf('create_ad_campaign', adPayload());
    expect(await lower({ payload: adPayload({ maxSpendCents: 10000, days: 3 }) })).toMatchObject({
      version: 2,
      payload: { maxSpendCents: 10000, days: 3 },
    });
  });

  test('a task that is not a storm plan can still change a text purpose and raise an ad', async () => {
    const sms = await stepOf('send_sms_batch', smsPayload({ dedupePrefix: undefined }), 'send_proposal');
    expect(await sms({ payload: smsPayload({ dedupePrefix: undefined, purpose: 'informational', body: 'Your crew arrives at 8am Tuesday.' }) })).toMatchObject({
      payload: { purpose: 'informational' },
    });
    const ad = await stepOf('create_ad_campaign', adPayload(), 'other_kind');
    expect(await ad({ payload: adPayload({ maxSpendCents: 50000, days: 10 }) })).toMatchObject({ version: 2 });
  });
});

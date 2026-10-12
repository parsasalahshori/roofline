import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { withTenant, type StepRow, type TenantContext } from '@roofline/db';
import { insertFixtureProperty, insertOmahaStorm, OMAHA_CORE, OMAHA_MIDDLE, type Query } from '@roofline/db/testing';
import { hailLabel, splitAdBudget, stormTitle } from '@roofline/shared';
import { JOB_HANDLERS } from '../src/jobs/handlers.ts';
import { UNFILLED_TEXT_REASON } from '../src/messaging/storm-text.ts';
import { draftStormPlan, STORM_OFF } from '../src/storm/plan.ts';
import { approveTask } from '../src/tasks/service.ts';
import { runStep } from '../src/tasks/runner.ts';
import { NO_UUID } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { rowFor, stepMessages } from './sms-helpers.ts';
import { dbSteps, dbTask, seenOf, setStep, setTask } from './task-helpers.ts';

/*
 * Storm plan drafting (S1 Task 11) against a real database. The storm, the company_storms row and the
 * storm_hits rows are inserted through the owner connection so each test controls exactly who was hit.
 * These tests need Docker and run on CI only.
 */

const NOW = new Date('2026-10-12T15:00:00Z');
const DAY = '2026-10-11';
const HOUR = 60 * 60 * 1000;
const MAX_IN = 1.75;
const PLACE = 'Omaha, NE';

let owner: pg.Pool;
let t: TestApp;
let companyStormId: string;

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

const companyId = () => t.seed.a.companyId;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  const stormId = await insertOmahaStorm(q, DAY);
  await q(`update storms set place_name = $2 where id = $1`, [stormId, PLACE]);
  // The seeded company has no mailing address; a plan needs one for its email.
  await q(
    `update companies set address_street = '1200 Farnam St', address_city = 'Omaha', address_state = 'NE', address_zip = '68102' where id = $1`,
    [companyId()],
  );
  const rows = await q(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit) values ($1, $2, $3, 3, 10) returning id`,
    [companyId(), stormId, MAX_IN],
  );
  companyStormId = rows[0]!.id as string;
});

type HitSpec = {
  consent?: string;
  phone?: boolean;
  email?: string | null;
  doNotContact?: boolean;
  archived?: boolean;
  hail?: number;
  /** false: a hit property that belongs to no customer. */
  customer?: boolean;
};

let counter = 0;

/** A customer (or bare property) hit by the storm. Returns the ids and the property's street. */
async function addHit(spec: HitSpec = {}): Promise<{ customerId: string; propertyId: string; street: string }> {
  counter += 1;
  const withCustomer = spec.customer !== false;
  const { propertyId, customerId } = await insertFixtureProperty(q, companyId(), counter % 2 === 0 ? OMAHA_CORE : OMAHA_MIDDLE, {
    withCustomer,
  });
  if (customerId !== null) {
    const phones = spec.phone === false ? [] : [{ e164: `+1402555${String(1000 + counter)}`, label: 'mobile', primary: true }];
    const emails = spec.email === undefined || spec.email === null ? [] : [spec.email];
    await q(
      `update customers set first_name = $2, sms_consent_status = $3, phones = $4::jsonb, emails = $5::jsonb,
         do_not_contact = $6, archived_at = $7 where id = $1`,
      [
        customerId,
        `Cust${counter}`,
        spec.consent ?? 'attested',
        JSON.stringify(phones),
        JSON.stringify(emails),
        spec.doNotContact === true,
        spec.archived === true ? NOW : null,
      ],
    );
  }
  await q(
    `insert into storm_hits (company_id, company_storm_id, property_id, customer_id, hail_in) values ($1, $2, $3, $4, $5)`,
    [companyId(), companyStormId, propertyId, customerId, spec.hail ?? MAX_IN],
  );
  const street = (await q(`select address_line from properties where id = $1`, [propertyId]))[0]!.address_line as string;
  return { customerId: customerId ?? '', propertyId, street };
}

const addAdAccount = (platform: 'google' | 'meta', status = 'active') =>
  q(`insert into ad_accounts (company_id, platform, external_account_id, status) values ($1, $2, $3, $4)`, [
    companyId(),
    platform,
    `ext-${platform}`,
    status,
  ]);
const setSettings = (set: string, values: unknown[] = []) =>
  q(`update company_settings set ${set} where company_id = $1`, [companyId(), ...values]);
const draft = async (): Promise<{ taskId: string }> => {
  const drafted = await draftStormPlan(t.deps, companyId(), companyStormId, NOW);
  if (drafted === null) throw new Error('The plan was not drafted.');
  return drafted;
};
const stepsOf = (taskId: string) => dbSteps(t, 'a', taskId);
const payloadOf = (s: StepRow) => s.payload as Record<string, unknown>;
const sorted = (ids: string[]) => [...ids].sort();
const planEmails = () => t.mailer.sent.filter((m) => m.subject.startsWith('Your storm plan is ready'));
const companyStormRow = async () => (await q(`select status, plan_task_id from company_storms where id = $1`, [companyStormId]))[0]!;
const taskCount = async () => Number((await q(`select count(*)::int as n from agent_tasks where company_id = $1`, [companyId()]))[0]!.n);

async function approveAs(who: 'owner' | 'office', taskId: string) {
  const member = t.seed.a[who];
  const ctx: TenantContext = { companyId: companyId(), userId: member.userId, role: who, canApproveSpend: false };
  const steps = await stepsOf(taskId);
  return withTenant(t.deps.pools, ctx, (tx) => approveTask(tx, ctx, taskId, seenOf(steps).steps, { now: t.clock.now() }));
}

describe('recipients', () => {
  test('recipients exclude do-not-contact, archived and informational-only consent', async () => {
    const attested = await addHit({ consent: 'attested' });
    const written = await addHit({ consent: 'written' });
    await addHit({ consent: 'express' });
    await addHit({ consent: 'none' });
    await addHit({ consent: 'revoked' });
    await addHit({ consent: 'attested', doNotContact: true });
    await addHit({ consent: 'attested', archived: true });
    await addHit({ consent: 'attested', phone: false });

    const { taskId } = await draft();
    const [sms] = await stepsOf(taskId);

    expect(sms!.type).toBe('send_sms_batch');
    expect(sorted(payloadOf(sms!).customerIds as string[])).toEqual(sorted([attested.customerId, written.customerId]));
    expect(sms!.enabled).toBe(true);
  });

  test('email recipients exclude opted-out addresses', async () => {
    const ok = await addHit({ email: 'ok@example.com' });
    const optedOut = await addHit({ email: 'Quiet@Example.com' });
    await addHit({ email: null });
    await addHit({ email: 'dnc@example.com', doNotContact: true });
    await addHit({ email: 'archived@example.com', archived: true });
    await q(`insert into email_opt_outs (company_id, email, source) values ($1, 'quiet@example.COM', 'link')`, [companyId()]);

    const { taskId } = await draft();
    const email = (await stepsOf(taskId))[1]!;

    expect(email.type).toBe('send_email_batch');
    expect(payloadOf(email).customerIds).toEqual([ok.customerId]);
    expect(payloadOf(email).customerIds).not.toContain(optedOut.customerId);
  });

  test('fields carry the street and hail size for each recipient', async () => {
    const a = await addHit({ email: 'a@example.com', hail: 1.75 });
    const b = await addHit({ email: 'b@example.com', hail: 1 });
    const stranger = await addHit({ customer: false });

    const { taskId } = await draft();
    const [sms, email] = await stepsOf(taskId);

    const smsFields = payloadOf(sms!).fields as Record<string, Record<string, string>>;
    expect(smsFields[a.customerId]).toMatchObject({ hail_size: '1.75"', street: a.street });
    expect(smsFields[b.customerId]).toMatchObject({ hail_size: hailLabel(1), street: b.street });
    for (const f of Object.values(smsFields)) {
      expect(typeof f.day).toBe('string');
      expect(f.day!.length).toBeGreaterThan(0);
    }
    const emailFields = payloadOf(email!).fields as Record<string, Record<string, string>>;
    expect(emailFields[a.customerId]).toMatchObject({ hail_size: '1.75"', street: a.street });
    // A home that is not a customer's contributes nothing: no key for it, and its street appears nowhere.
    expect(Object.keys(smsFields).sort()).toEqual(sorted([a.customerId, b.customerId]));
    expect(JSON.stringify(payloadOf(sms!))).not.toContain(stranger.street);
    expect(JSON.stringify(payloadOf(email!))).not.toContain(stranger.street);
  });
});

describe('off reasons', () => {
  test('off reasons', async () => {
    await addHit({ email: 'a@example.com' });

    // (a) texting not approved
    await q(`update texting_registrations set campaign_status = 'pending' where company_id = $1`, [companyId()]);
    let steps = await stepsOf((await draft()).taskId);
    expect(steps[0]).toMatchObject({ enabled: false, errorPlain: "Texting isn't approved yet." });
    expect((steps[0]!.preview as { offReason?: string }).offReason).toBe("Texting isn't approved yet.");
    await q(`update texting_registrations set campaign_status = 'approved' where company_id = $1`, [companyId()]);

    // (b) emails off, then no mailing address
    await setSettings('storm_email_enabled = false');
    steps = await stepsOf((await draft()).taskId);
    expect(steps[1]).toMatchObject({ enabled: false, errorPlain: STORM_OFF.emailsOff });
    await setSettings('storm_email_enabled = true');
    await q(`update companies set address_street = null where id = $1`, [companyId()]);
    steps = await stepsOf((await draft()).taskId);
    expect(steps[1]).toMatchObject({ enabled: false, errorPlain: 'Add your mailing address in Settings → Company' });
    await q(`update companies set address_street = '1200 Farnam St' where id = $1`, [companyId()]);
    steps = await stepsOf((await draft()).taskId);
    expect(steps[1]!.enabled).toBe(true);

    // (c) no homes hit: no routes
    await q(`update company_storms set homes_hit = 0 where id = $1`, [companyStormId]);
    steps = await stepsOf((await draft()).taskId);
    expect(steps[2]).toMatchObject({ enabled: false, errorPlain: STORM_OFF.noHomes });
    await q(`update company_storms set homes_hit = 10 where id = $1`, [companyStormId]);
    steps = await stepsOf((await draft()).taskId);
    expect(steps[2]!.enabled).toBe(true);

    // (d) ad accounts: none (or not active) means off; an active one turns the step on
    expect(steps[3]).toMatchObject({ enabled: false, errorPlain: 'No Google Ads account connected' });
    expect(steps[4]).toMatchObject({ enabled: false, errorPlain: 'No Facebook and Instagram ad account connected' });
    await addAdAccount('google', 'pending');
    steps = await stepsOf((await draft()).taskId);
    expect(steps[3]).toMatchObject({ enabled: false, errorPlain: 'No Google Ads account connected' });
    await q(`update ad_accounts set status = 'active' where company_id = $1 and platform = 'google'`, [companyId()]);
    await addAdAccount('meta');
    steps = await stepsOf((await draft()).taskId);
    expect(steps[3]!.enabled).toBe(true);
    expect(steps[4]!.enabled).toBe(true);

    // (e) a 0% Google share turns Google off and gives Meta the whole budget
    await setSettings('storm_ad_google_share_pct = 0');
    steps = await stepsOf((await draft()).taskId);
    expect(steps[3]).toMatchObject({ enabled: false, errorPlain: STORM_OFF.googleBudgetSmall });
    expect(steps[4]!.enabled).toBe(true);
    expect(payloadOf(steps[4]!).maxSpendCents).toBe(27000);
  });

  test('no customers to text turns the text step off with an empty list', async () => {
    await addHit({ consent: 'express' });
    const [sms] = await stepsOf((await draft()).taskId);
    expect(sms).toMatchObject({ enabled: false, errorPlain: STORM_OFF.noSmsRecipients });
    expect(payloadOf(sms!).customerIds).toEqual([]);
  });
});

describe('the plan', () => {
  test('step payloads carry the storm settings', async () => {
    await addHit({ email: 'a@example.com' });
    await addAdAccount('google');
    await addAdAccount('meta');
    await setSettings('storm_ad_budget_cents = 40000, storm_ad_days = 10, storm_ad_google_share_pct = 60');

    let steps = await stepsOf((await draft()).taskId);
    expect(steps.map((s) => s.type)).toEqual([
      'send_sms_batch',
      'send_email_batch',
      'build_routes',
      'create_ad_campaign',
      'create_ad_campaign',
    ]);
    const prefix = `storm:${companyStormId}`;
    expect(payloadOf(steps[0]!)).toMatchObject({ purpose: 'marketing', dedupePrefix: prefix });
    expect(payloadOf(steps[1]!)).toMatchObject({ dedupePrefix: prefix, companyStormId });
    const split = splitAdBudget(40000, 60);
    const google = payloadOf(steps[3]!);
    const meta = payloadOf(steps[4]!);
    expect(google.maxSpendCents).toBe(split.google);
    expect(meta.maxSpendCents).toBe(split.meta);
    expect((google.maxSpendCents as number) + (meta.maxSpendCents as number)).toBe(40000);
    expect(google.days).toBe(10);
    expect(meta.days).toBe(10);
    expect(meta.photoId).toBeNull();

    // Both reps take the doors; the newest photo is the one the Meta ad uses.
    const routes = payloadOf(steps[2]!);
    expect(routes.maxDoors).toBe(1500);
    expect(routes.companyStormId).toBe(companyStormId);
    expect(sorted(routes.repUserIds as string[])).toEqual(sorted([t.seed.a.rep.userId, t.seed.a.otherRep.userId]));
    const older = await q(
      `insert into stored_files (company_id, kind, object_key, sha256, bytes, content_type) values ($1, 'signed_proposal_pdf', 'k1', 'h1', 1, 'image/png') returning id`,
      [companyId()],
    );
    const newer = await q(
      `insert into stored_files (company_id, kind, object_key, sha256, bytes, content_type) values ($1, 'signed_proposal_pdf', 'k2', 'h2', 1, 'image/png') returning id`,
      [companyId()],
    );
    await q(`insert into storm_photos (company_id, stored_file_id, created_at) values ($1, $2, $3)`, [
      companyId(),
      older[0]!.id,
      new Date(NOW.getTime() - 24 * HOUR),
    ]);
    const photo = await q(`insert into storm_photos (company_id, stored_file_id, created_at) values ($1, $2, $3) returning id`, [
      companyId(),
      newer[0]!.id,
      NOW,
    ]);
    steps = await stepsOf((await draft()).taskId);
    expect(payloadOf(steps[4]!).photoId).toBe(photo[0]!.id);

    // With no rep, the owner takes the doors.
    await q(`delete from memberships where company_id = $1 and role = 'rep'`, [companyId()]);
    steps = await stepsOf((await draft()).taskId);
    expect(payloadOf(steps[2]!).repUserIds).toEqual([t.seed.a.owner.userId]);
  });

  test('the plan expires 48 hours after it is drafted', async () => {
    await addHit({ email: 'a@example.com' });
    const { taskId } = await draft();
    const task = await dbTask(t, 'a', taskId);

    expect(task.expiresAt).toEqual(new Date(NOW.getTime() + 48 * HOUR));
    expect(task).toMatchObject({
      agent: 'storm_scout',
      kind: 'storm_plan',
      title: stormTitle(PLACE, MAX_IN),
      subjectType: 'company_storm',
      subjectId: companyStormId,
      status: 'draft',
    });
    const row = await companyStormRow();
    expect(row).toMatchObject({ status: 'planned', plan_task_id: taskId });

    // One plan-ready email to the owner and one to the office member.
    const mails = planEmails();
    expect(mails.map((m) => m.to).sort()).toEqual([t.seed.a.office.email, t.seed.a.owner.email].sort());
  });
});

describe('re-drafting', () => {
  test('re-drafting replaces a draft plan', async () => {
    await addHit({ email: 'a@example.com' });
    const first = await draft();
    const second = await draft();

    expect(second.taskId).not.toBe(first.taskId);
    expect((await dbTask(t, 'a', first.taskId)).status).toBe('declined');
    expect((await stepsOf(first.taskId)).map((s) => s.status)).toEqual(Array(5).fill('skipped'));
    expect((await dbTask(t, 'a', second.taskId)).status).toBe('draft');
    expect((await companyStormRow()).plan_task_id).toBe(second.taskId);
  });

  test('returns { taskId } on success', async () => {
    await addHit({ email: 'a@example.com' });
    const drafted = await draftStormPlan(t.deps, companyId(), companyStormId, NOW);
    expect(drafted).not.toBeNull();
    expect(drafted).toEqual({ taskId: expect.any(String) });
  });

  test.each(['expired', 'declined'] as const)('a %s plan is re-drafted into a new task, the old one keeps its status', async (status) => {
    await addHit({ email: 'a@example.com' });
    const first = await draft();
    await setTask(t, 'a', first.taskId, { status });

    const second = await draft();

    expect(second.taskId).not.toBe(first.taskId);
    expect((await companyStormRow()).plan_task_id).toBe(second.taskId);
    expect((await dbTask(t, 'a', first.taskId)).status).toBe(status);
    expect((await dbTask(t, 'a', second.taskId)).status).toBe('draft');
  });

  test.each(['approved', 'running', 'awaiting_owner', 'partly_done', 'needs_attention', 'done'] as const)(
    'a %s plan is left alone',
    async (status) => {
      await addHit({ email: 'a@example.com' });
      const first = await draft();
      await setTask(t, 'a', first.taskId, { status });
      const mailsBefore = planEmails().length;
      const tasksBefore = await taskCount();

      expect((await draft()).taskId).toBe(first.taskId);

      expect((await companyStormRow()).plan_task_id).toBe(first.taskId);
      expect((await dbTask(t, 'a', first.taskId)).status).toBe(status);
      expect(await taskCount()).toBe(tasksBefore);
      expect(planEmails()).toHaveLength(mailsBefore);
    },
  );

  test('a re-draft of a draft sends no second ready email, a re-draft after expiry or decline sends one', async () => {
    await addHit({ email: 'a@example.com' });
    const first = await draft();
    const perAlert = planEmails().length;
    expect(perAlert).toBeGreaterThan(0);

    const second = await draft();
    expect(planEmails()).toHaveLength(perAlert);

    await setTask(t, 'a', second.taskId, { status: 'expired' });
    const third = await draft();
    expect(third.taskId).not.toBe(second.taskId);
    expect(planEmails()).toHaveLength(perAlert * 2);

    await setTask(t, 'a', third.taskId, { status: 'declined' });
    await draft();
    expect(planEmails()).toHaveLength(perAlert * 3);
    expect(first.taskId).not.toBe(second.taskId);
  });

  test('a dismissed storm is not drafted', async () => {
    await q(`update company_storms set status = 'dismissed' where id = $1`, [companyStormId]);
    await expect(draft()).rejects.toThrow();
    expect(await taskCount()).toBe(0);
    expect(t.mailer.sent).toEqual([]);
  });

  test('an unknown storm id is not drafted', async () => {
    await expect(draftStormPlan(t.deps, companyId(), NO_UUID, NOW)).rejects.toThrow();
    expect(await taskCount()).toBe(0);
  });
});

describe('approval', () => {
  test('partial approval: the office approves the message and internal steps, the ad steps wait as awaiting_owner', async () => {
    await addHit({ email: 'a@example.com' });
    await addAdAccount('google');
    await addAdAccount('meta');
    const { taskId } = await draft();

    const out = await approveAs('office', taskId);

    expect(out!.toEnqueue).toHaveLength(3);
    expect((await stepsOf(taskId)).map((s) => s.status)).toEqual(['queued', 'queued', 'queued', 'awaiting_owner', 'awaiting_owner']);
    expect((await dbTask(t, 'a', taskId)).status).toBe('awaiting_owner');
  });

  test('an off step is skipped when the plan is approved', async () => {
    await addHit({ email: 'a@example.com' });
    await setSettings('storm_email_enabled = false');
    const { taskId } = await draft();

    await approveAs('owner', taskId);

    // Texts and routes run; email, Google and Meta are off.
    expect((await stepsOf(taskId)).map((s) => s.status)).toEqual(['queued', 'skipped', 'queued', 'skipped', 'skipped']);
  });
});

describe('sending the drafted text', () => {
  test('a text with an unfilled storm token is blocked, not sent', async () => {
    const withFields = await addHit({ email: 'a@example.com' });
    const missing = await addHit({ email: 'b@example.com' });
    await q(`update properties set timezone = 'America/Chicago' where company_id = $1`, [companyId()]);

    const { taskId } = await draft();
    const sms = (await stepsOf(taskId))[0]!;
    const payload = payloadOf(sms);
    const fields = { ...(payload.fields as Record<string, Record<string, string>>) };
    delete fields[missing.customerId];
    await setStep(t, 'a', sms.id, { payload: { ...payload, fields } });

    await approveAs('owner', taskId);
    await runStep(t.deps, companyId(), sms.id);

    const rows = await stepMessages(t, 'a', sms.id);
    expect(rowFor(rows, missing.customerId)).toMatchObject({
      status: 'blocked',
      blockRule: 'content',
      blockReason: UNFILLED_TEXT_REASON,
    });
    expect(t.sms.sent).toHaveLength(1);
    const body = t.sms.sent[0]!.body;
    expect(body).toContain('Radar shows hail up to ');
    expect(body).toContain('1.75"');
    expect(body).toContain(withFields.street);
    expect(body).not.toContain('{');
    expect(rowFor(rows, withFields.customerId).status).toBe('sent');
  });
});

describe('the storm-draft job', () => {
  test('the storm-draft job validates and drafts', async () => {
    await addHit({ email: 'a@example.com' });
    const meta = { attempt: 1, lastAttempt: false };

    await expect(JOB_HANDLERS['storm-draft'](t.deps, { companyId: companyId(), companyStormId: 'nope' }, meta)).rejects.toThrow();

    await JOB_HANDLERS['storm-draft'](t.deps, { companyId: companyId(), companyStormId }, meta);

    const row = await companyStormRow();
    expect(row.plan_task_id).not.toBeNull();
    const task = await dbTask(t, 'a', row.plan_task_id as string);
    expect(task.expiresAt).toEqual(new Date(NOW.getTime() + 48 * HOUR));
    expect(row.status).toBe('planned');
  });

  test('a dismissed storm and an unknown storm do not throw (permanent failures are logged and dropped)', async () => {
    const meta = { attempt: 1, lastAttempt: false };
    await expect(JOB_HANDLERS['storm-draft'](t.deps, { companyId: companyId(), companyStormId: NO_UUID }, meta)).resolves.toBeUndefined();

    await q(`update company_storms set status = 'dismissed' where id = $1`, [companyStormId]);
    await expect(JOB_HANDLERS['storm-draft'](t.deps, { companyId: companyId(), companyStormId }, meta)).resolves.toBeUndefined();
    expect(await taskCount()).toBe(0);
  });
});

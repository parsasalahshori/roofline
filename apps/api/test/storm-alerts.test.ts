import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { insertFixtureStorm, OMAHA_CONTOURS, type Query } from '@roofline/db/testing';
import { JOB_HANDLERS } from '../src/jobs/handlers.ts';
import { alertNow, alertPlanReady, alertUnalerted, sendStormAlert } from '../src/storm/alerts.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * Storm alert emails (S1 Task 10) against a real database. These tests need Docker and run on CI only.
 */

const NOW = new Date('2026-10-12T15:00:00Z');

let owner: pg.Pool;
let t: TestApp;
let companyStormId: string;
let stormId: string;
let offEmail: string;

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  const companyId = t.seed.a.companyId;
  // A second office member with storm alerts turned off.
  offEmail = 'office-quiet@acme.test';
  const users = await q(
    `insert into users (email, name, password_hash, email_verified_at)
     select $1, 'Quiet Office', password_hash, now() from users where email = $2 returning id`,
    [offEmail, t.seed.a.owner.email],
  );
  await q(
    `insert into memberships (company_id, user_id, role, status, storm_alert_email) values ($1, $2, 'office', 'active', false)`,
    [companyId, users[0]!.id],
  );
  stormId = await insertFixtureStorm(q, { convectiveDay: '2026-10-11', contours: OMAHA_CONTOURS, maxIn: 1.25 });
  await q(`update storms set place_name = 'Omaha, NE' where id = $1`, [stormId]);
  const rows = await q(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit)
     values ($1, $2, 1.25, 7, 42) returning id`,
    [companyId, stormId],
  );
  companyStormId = rows[0]!.id as string;
});

const companyId = () => t.seed.a.companyId;
const recipients = () => t.mailer.sent.map((m) => m.to).sort();

describe('now alert', () => {
  test('sends one now email per storm even across ten matches', async () => {
    for (let i = 0; i < 10; i++) await alertNow(t.deps, companyId(), companyStormId);
    expect(t.mailer.sent).toHaveLength(2);
    const rows = await q('select alerted_at from company_storms where id = $1', [companyStormId]);
    expect(rows[0]!.alerted_at).not.toBeNull();
  });

  test('members with alerts off get no now email', async () => {
    await alertNow(t.deps, companyId(), companyStormId);
    expect(recipients()).not.toContain(offEmail);
    expect(recipients()).toEqual([t.seed.a.office.email, t.seed.a.owner.email].sort());
  });

  test('reps get no now email', async () => {
    await alertNow(t.deps, companyId(), companyStormId);
    expect(recipients()).not.toContain(t.seed.a.rep.email);
  });

  test('the now email says radar-estimated, the size and links to the storm', async () => {
    await alertNow(t.deps, companyId(), companyStormId);
    const mail = t.mailer.sent[0]!;
    expect(mail.subject).toBe('Hail near Omaha, NE — up to 1.25" (radar-estimated)');
    expect(mail.text).toContain('radar-estimated');
    expect(mail.text).toContain(`${t.deps.config.APP_ORIGIN}/storm/${companyStormId}`);
  });
});

describe('plan alert', () => {
  test('alertPlanReady emails the same recipients with the counts', async () => {
    const taskId = '11111111-1111-4111-8111-111111111111';
    await alertPlanReady(t.deps, companyId(), companyStormId, taskId);
    expect(recipients()).toEqual([t.seed.a.office.email, t.seed.a.owner.email].sort());
    const mail = t.mailer.sent[0]!;
    expect(mail.subject).toBe('Your storm plan is ready: 7 customers, 42 homes');
    expect(mail.text).toContain('radar-estimated');
    expect(mail.text).toContain(`${t.deps.config.APP_ORIGIN}/storm/${companyStormId}?task=${taskId}`);
  });

  test('sendStormAlert with kind plan does nothing without a plan task', async () => {
    await sendStormAlert(t.deps, companyId(), companyStormId, 'plan');
    expect(t.mailer.sent).toEqual([]);
  });
});

describe('failures', () => {
  test('a failing mailer for one recipient does not stop the others', async () => {
    const failFor = t.seed.a.office.email;
    const original = t.mailer.send.bind(t.mailer);
    t.mailer.send = async (msg) => {
      if (msg.to === failFor) throw new Error('mailbox down');
      return original(msg);
    };
    await expect(alertNow(t.deps, companyId(), companyStormId)).resolves.toBeUndefined();
    expect(recipients()).toEqual([t.seed.a.owner.email]);
    expect(t.logged).toHaveLength(1);
  });
});

describe('retries', () => {
  const alertedAt = async () => (await q('select alerted_at from company_storms where id = $1', [companyStormId]))[0]!.alerted_at;

  test('when every send fails the claim is released and the next alert emails again', async () => {
    const original = t.mailer.send.bind(t.mailer);
    t.mailer.send = async () => {
      throw new Error('mail down');
    };
    await alertNow(t.deps, companyId(), companyStormId);
    expect(await alertedAt()).toBeNull();
    t.mailer.send = original;
    await alertNow(t.deps, companyId(), companyStormId);
    expect(t.mailer.sent).toHaveLength(2);
    expect(await alertedAt()).not.toBeNull();
  });

  test('when only one send fails the storm stays claimed', async () => {
    const original = t.mailer.send.bind(t.mailer);
    t.mailer.send = async (msg) => {
      if (msg.to === t.seed.a.office.email) throw new Error('mailbox down');
      return original(msg);
    };
    await alertNow(t.deps, companyId(), companyStormId);
    expect(await alertedAt()).not.toBeNull();
  });

  test('alertUnalerted alerts a matched storm whose alert was never claimed', async () => {
    await alertUnalerted(t.deps, companyId());
    expect(t.mailer.sent).toHaveLength(2);
    expect(await alertedAt()).not.toBeNull();
    await alertUnalerted(t.deps, companyId());
    expect(t.mailer.sent).toHaveLength(2);
  });
});

describe('job handlers', () => {
  test('storm job handlers reject a bad companyStormId or kind', () => {
    const meta = { attempt: 1, lastAttempt: false };
    const base = { companyId: companyId() };
    expect(() => JOB_HANDLERS['storm-draft'](t.deps, { ...base, companyStormId: 'nope' }, meta)).toThrow(
      'A storm job did not name a company storm.',
    );
    expect(() => JOB_HANDLERS['storm-alert'](t.deps, { ...base, companyStormId, kind: 'weird' as 'now' }, meta)).toThrow(
      'A storm alert job did not name a kind.',
    );
    expect(() => JOB_HANDLERS['storm-alert'](t.deps, { ...base, companyStormId: 'nope', kind: 'now' }, meta)).toThrow(
      'A storm job did not name a company storm.',
    );
  });
});

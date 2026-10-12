import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { companySettings } from '@roofline/db';
import { Actors, dbAudit, inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { NOT_ALLOWED } from './task-helpers.ts';

const PATH = '/api/agent-values';

const PERCENT = 'Please enter a percent from 0 to 100.';
const GUST = 'Please enter a whole number of miles per hour from 1 to 100.';
const HOUR = 'Please pick an hour from 0 to 23.';
const NUDGE = 'Please enter three whole numbers of days from 1 to 60.';
const LEAD = 'Please enter a whole number of days from 1 to 30.';
const FOLLOWUP = 'Please enter two whole numbers of days from 1 to 30.';
const REVIEW_DELAY = 'Please enter a whole number of days from 0 to 30.';
const LINK = 'Please enter a web address that starts with https://';

let t: TestApp;
let actors: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  actors = new Actors(t);
});

const owner = () => actors.as('owner');

/** A PATCH as the owner: the response to check. */
async function patch(body: Record<string, unknown>) {
  return (await owner()).patch(PATH).send(body);
}

/** The company_settings row of company a, read straight from the table. */
const settingsRow = (companyId: string) =>
  inCompany(t, companyId, (tx) => tx.select().from(companySettings).where(eq(companySettings.companyId, companyId)));

describe('GET /api/agent-values', () => {
  test('returns the defaults for a company that has not changed them', async () => {
    const res = await (await owner()).get(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      claimsNudgeDays: [3, 5, 7],
      weatherRainPct: 60,
      weatherGustMph: 25,
      reminderHour: 15,
      followupDays: [3, 4],
      leadFollowupDays: 2,
      reviewLink: null,
      reviewDelayDays: 3,
      followupReviews: true,
      followupLeads: true,
      followupProposals: true,
    });
  });

  test('is 403 for a rep and for an office member (company_admin is owner only)', async () => {
    for (const who of ['rep', 'office'] as const) {
      const res = await (await actors.as(who)).get(PATH);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(NOT_ALLOWED);
    }
  });
});

describe('PATCH /api/agent-values bounds', () => {
  test('weatherRainPct accepts 0 and 100, refuses 101 and -1', async () => {
    for (const ok of [0, 100]) {
      const res = await patch({ weatherRainPct: ok });
      expect(res.status).toBe(200);
      expect(res.body.weatherRainPct).toBe(ok);
    }
    for (const bad of [101, -1, 60.5]) {
      const res = await patch({ weatherRainPct: bad });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: PERCENT, field: 'weatherRainPct' });
    }
  });

  test('weatherGustMph accepts 1 and 100, refuses 0 and 101', async () => {
    for (const ok of [1, 100]) {
      const res = await patch({ weatherGustMph: ok });
      expect(res.status).toBe(200);
      expect(res.body.weatherGustMph).toBe(ok);
    }
    for (const bad of [0, 101]) {
      const res = await patch({ weatherGustMph: bad });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: GUST, field: 'weatherGustMph' });
    }
  });

  test('reminderHour accepts 0 and 23, refuses 24', async () => {
    for (const ok of [0, 23]) {
      const res = await patch({ reminderHour: ok });
      expect(res.status).toBe(200);
      expect(res.body.reminderHour).toBe(ok);
    }
    const res = await patch({ reminderHour: 24 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: HOUR, field: 'reminderHour' });
  });

  test('leadFollowupDays accepts 1 and 30, refuses 0 and 31', async () => {
    for (const ok of [1, 30]) {
      const res = await patch({ leadFollowupDays: ok });
      expect(res.status).toBe(200);
      expect(res.body.leadFollowupDays).toBe(ok);
    }
    for (const bad of [0, 31]) {
      const res = await patch({ leadFollowupDays: bad });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: LEAD, field: 'leadFollowupDays' });
    }
  });

  test('reviewDelayDays accepts 0 and 30, refuses 31', async () => {
    for (const ok of [0, 30]) {
      const res = await patch({ reviewDelayDays: ok });
      expect(res.status).toBe(200);
      expect(res.body.reviewDelayDays).toBe(ok);
    }
    const res = await patch({ reviewDelayDays: 31 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: REVIEW_DELAY, field: 'reviewDelayDays' });
  });

  test('claimsNudgeDays takes three whole numbers from 1 to 60, one per stage, in any order', async () => {
    for (const good of [
      [1, 2, 60],
      [5, 3, 7],
      [3, 3, 7],
    ]) {
      const res = await patch({ claimsNudgeDays: good });
      expect(res.status).toBe(200);
      expect(res.body.claimsNudgeDays).toEqual(good);
    }
  });

  test('claimsNudgeDays refuses a zero, a 61, a fraction and a short list', async () => {
    for (const bad of [
      [0, 2, 3],
      [3, 5, 61],
      [3, 5.5, 7],
      [3, 5],
    ]) {
      const res = await patch({ claimsNudgeDays: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(NUDGE);
      expect(res.body.field).toMatch(/^claimsNudgeDays(\.\d+)?$/);
    }
  });

  test('followupDays accepts [1, 30] and does not require increasing order', async () => {
    const ok = await patch({ followupDays: [1, 30] });
    expect(ok.status).toBe(200);
    expect(ok.body.followupDays).toEqual([1, 30]);
    const descending = await patch({ followupDays: [4, 2] });
    expect(descending.status).toBe(200);
    expect(descending.body.followupDays).toEqual([4, 2]);
  });

  test('followupDays refuses [0, 3], [3, 31] and a fraction', async () => {
    for (const bad of [
      [0, 3],
      [3, 31],
      [3, 2.5],
    ]) {
      const res = await patch({ followupDays: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(FOLLOWUP);
      expect(res.body.field).toMatch(/^followupDays(\.\d+)?$/);
    }
  });

  test('a non-integer number is refused for a whole-number field', async () => {
    const res = await patch({ leadFollowupDays: 2.5 });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('leadFollowupDays');
  });
});

describe('PATCH /api/agent-values review link', () => {
  test('an http:// link is refused with the plain message', async () => {
    const res = await patch({ reviewLink: 'http://x.example' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: LINK, field: 'reviewLink' });
  });

  test('an https:// link is kept as written', async () => {
    const res = await patch({ reviewLink: 'https://x.example/r' });
    expect(res.status).toBe(200);
    expect(res.body.reviewLink).toBe('https://x.example/r');
  });

  test('an empty string is stored as null', async () => {
    await patch({ reviewLink: 'https://x.example/r' });
    const res = await patch({ reviewLink: '' });
    expect(res.status).toBe(200);
    expect(res.body.reviewLink).toBeNull();
    const rows = await settingsRow(t.seed.a.companyId);
    expect(rows[0]!.reviewLink).toBeNull();
  });

  test('a link longer than 500 characters is refused', async () => {
    const res = await patch({ reviewLink: `https://x.example/${'a'.repeat(500)}` });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: LINK, field: 'reviewLink' });
  });
});

describe('PATCH /api/agent-values fields and flags', () => {
  test('the three switches save and read back', async () => {
    const res = await patch({ followupReviews: false, followupLeads: false, followupProposals: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ followupReviews: false, followupLeads: false, followupProposals: true });
  });

  test('an unknown field is refused with 400 and names the field', async () => {
    const res = await patch({ weatherRainPct: 50, notAField: 1 });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('notAField');
    expect(res.body.error).toBe('Please check this field.');
    const rows = await settingsRow(t.seed.a.companyId);
    expect(rows[0]!.weatherRainPct).toBe(60);
  });

  test('an empty patch returns the current values and writes no audit row', async () => {
    const res = await patch({});
    expect(res.status).toBe(200);
    expect(res.body.weatherRainPct).toBe(60);
    expect(await dbAudit(t, t.seed.a.companyId, 'settings.update')).toHaveLength(0);
  });

  test('a patch changes only the fields it sends', async () => {
    await patch({ reminderHour: 9 });
    const res = await patch({ weatherGustMph: 30 });
    expect(res.body).toMatchObject({ reminderHour: 9, weatherGustMph: 30, weatherRainPct: 60 });
  });
});

describe('PATCH /api/agent-values role and audit', () => {
  test('a rep gets 403 and nothing changes', async () => {
    const rep = await actors.as('rep');
    const res = await rep.patch(PATH).send({ reminderHour: 9 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(NOT_ALLOWED);
    const rows = await settingsRow(t.seed.a.companyId);
    expect(rows[0]!.reminderHour).toBe(15);
  });

  test('an office member gets 403 too: company_admin is owner only', async () => {
    const office = await actors.as('office');
    const res = await office.patch(PATH).send({ reminderHour: 9 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(NOT_ALLOWED);
  });

  test('writes one settings.update audit row that names the touched fields and not their values', async () => {
    await patch({ weatherRainPct: 42, reviewLink: 'https://x.example/secret-review-link' });
    const rows = await dbAudit(t, t.seed.a.companyId, 'settings.update');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actorUserId).toBe(actors.user('owner').userId);
    const details = JSON.stringify(row.after);
    expect(row.after).toEqual({ fields: expect.arrayContaining(['weatherRainPct', 'reviewLink']) });
    expect(details).not.toContain('42');
    expect(details).not.toContain('secret-review-link');
  });

  test('a change in company a never shows in company b', async () => {
    await patch({ reminderHour: 4 });
    const ownerB = await actors.as('owner', 'b');
    const res = await ownerB.get(PATH);
    expect(res.body.reminderHour).toBe(15);
  });
});

import { beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_WORK_HOURS, type ScheduleSettings, type WorkHours } from '@roofline/shared';
import { Actors, dbAudit, NO_UUID, NOT_FOUND } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const NOT_ALLOWED = "Your role can't do that. Ask the owner.";

/** Monday 09:00-17:00; every other day keeps the company default. */
const CUSTOM_MON: WorkHours = { ...DEFAULT_WORK_HOURS, mon: [['09:00', '17:00']] };
/** One member's own week: a short Friday. */
const MY_HOURS: WorkHours = { ...DEFAULT_WORK_HOURS, fri: [['10:00', '15:00']] };

const CUSTOM: ScheduleSettings = { workHours: CUSTOM_MON, travelBufferMinutes: 45, minNoticeMinutes: 60, stuckAfterDays: 10 };
const DEFAULTS: ScheduleSettings = { workHours: DEFAULT_WORK_HOURS, travelBufferMinutes: 30, minNoticeMinutes: 120, stuckAfterDays: 14 };

type SettingName = 'travelBufferMinutes' | 'minNoticeMinutes' | 'stuckAfterDays';

let t: TestApp;
let who: Actors;

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  t.clock.set(new Date('2026-10-12T15:00:00.000Z'));
});

const A = () => t.seed.a.companyId;
const B = () => t.seed.b.companyId;

describe('company schedule settings', () => {
  test('before anyone saves: company work hours, 30 minutes of travel, 120 of notice, 14 stuck days', async () => {
    const owner = await who.as('owner');
    const res = await owner.get('/api/calendar/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEFAULTS);
  });

  test('an owner saves, and the owner, office and rep all read the same settings back', async () => {
    const owner = await who.as('owner');
    const put = await owner.put('/api/calendar/settings').send(CUSTOM);
    expect(put.status).toBe(200);
    expect(put.body).toEqual(CUSTOM);

    for (const member of ['owner', 'office', 'rep'] as const) {
      const agent = await who.as(member);
      const res = await agent.get('/api/calendar/settings');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(CUSTOM);
    }
  });

  test('the save is audited with its actor and the saved values', async () => {
    const owner = await who.as('owner');
    await owner.put('/api/calendar/settings').send(CUSTOM).expect(200);
    const rows = await dbAudit(t, A(), 'calendar.settings');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorUserId).toBe(t.seed.a.owner.userId);
    expect(rows[0]!.after).toEqual(CUSTOM);
  });
});

describe('validation of company settings', () => {
  test('hours that end before they start are refused, and the field names the day', async () => {
    const owner = await who.as('owner');
    const res = await owner
      .put('/api/calendar/settings')
      .send({ ...CUSTOM, workHours: { ...DEFAULT_WORK_HOURS, mon: [['18:00', '08:00']] } });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('workHours.mon');
    expect(res.body.error).toMatch(/^mon:/);
  });

  test.each<[SettingName, number]>([
    ['travelBufferMinutes', 121],
    ['minNoticeMinutes', 4321],
    ['stuckAfterDays', 2],
    ['stuckAfterDays', 91],
  ])('%s = %i is refused on that field', async (field, value) => {
    const owner = await who.as('owner');
    const res = await owner.put('/api/calendar/settings').send({ ...CUSTOM, [field]: value });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe(field);
    expect(typeof res.body.error).toBe('string');
  });

  test.each<[SettingName, number]>([
    ['travelBufferMinutes', 0],
    ['travelBufferMinutes', 120],
    ['minNoticeMinutes', 0],
    ['minNoticeMinutes', 4320],
    ['stuckAfterDays', 3],
    ['stuckAfterDays', 90],
  ])('%s = %i is allowed', async (field, value) => {
    const owner = await who.as('owner');
    const res = await owner.put('/api/calendar/settings').send({ ...CUSTOM, [field]: value });
    expect(res.status).toBe(200);
    expect(res.body[field]).toBe(value);
  });
});

describe('who may change what', () => {
  test('an office user or a rep cannot change company settings, and nothing changes', async () => {
    const office = await who.as('office');
    const officeRes = await office.put('/api/calendar/settings').send(CUSTOM);
    expect(officeRes.status).toBe(403);
    expect(officeRes.body).toEqual({ error: NOT_ALLOWED });

    const rep = await who.as('rep');
    const repRes = await rep.put('/api/calendar/settings').send(CUSTOM);
    expect(repRes.status).toBe(403);
    expect(repRes.body).toEqual({ error: NOT_ALLOWED });

    const owner = await who.as('owner');
    expect((await owner.get('/api/calendar/settings')).body).toEqual(DEFAULTS);
    expect(await dbAudit(t, A(), 'calendar.settings')).toHaveLength(0);
  });

  test('an office user sets their own hours, reads them back as custom, and returns to company hours', async () => {
    const owner = await who.as('owner');
    await owner.put('/api/calendar/settings').send(CUSTOM).expect(200);

    const office = await who.as('office');
    const put = await office.put('/api/calendar/my-hours').send({ workHours: MY_HOURS });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ workHours: MY_HOURS, custom: true });

    const read = await office.get('/api/calendar/my-hours');
    expect(read.body).toEqual({ workHours: MY_HOURS, custom: true });

    const back = await office.put('/api/calendar/my-hours').send({ workHours: null });
    expect(back.status).toBe(200);
    expect(back.body).toEqual({ workHours: CUSTOM_MON, custom: false });
  });

  test('a rep sets their own hours too', async () => {
    const rep = await who.as('rep');
    const put = await rep.put('/api/calendar/my-hours').send({ workHours: MY_HOURS });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ workHours: MY_HOURS, custom: true });
  });

  test('my-hours with invalid hours names the day', async () => {
    const rep = await who.as('rep');
    const res = await rep.put('/api/calendar/my-hours').send({ workHours: { ...DEFAULT_WORK_HOURS, wed: [['12:00', '09:00']] } });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('workHours.wed');
    expect(res.body.error).toMatch(/^wed:/);
  });

  test('an owner sets a member\'s hours; the member reads them; an office user or a rep cannot set them', async () => {
    const owner = await who.as('owner');
    const repId = t.seed.a.rep.userId;

    const put = await owner.put(`/api/calendar/hours/${repId}`).send({ workHours: MY_HOURS });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ workHours: MY_HOURS, custom: true });

    const rep = await who.as('rep');
    expect((await rep.get('/api/calendar/my-hours')).body).toEqual({ workHours: MY_HOURS, custom: true });

    const office = await who.as('office');
    const officeRes = await office.put(`/api/calendar/hours/${repId}`).send({ workHours: MY_HOURS });
    expect(officeRes.status).toBe(403);
    expect(officeRes.body).toEqual({ error: NOT_ALLOWED });

    const repRes = await rep.put(`/api/calendar/hours/${repId}`).send({ workHours: MY_HOURS });
    expect(repRes.status).toBe(403);
    expect(repRes.body).toEqual({ error: NOT_ALLOWED });
  });

  test('an owner setting hours for an id that is not a member gets not found', async () => {
    const owner = await who.as('owner');
    const res = await owner.put(`/api/calendar/hours/${NO_UUID}`).send({ workHours: MY_HOURS });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });
  });
});

describe('company B', () => {
  test("company B's owner cannot set hours for a company A member, and the two companies keep separate settings", async () => {
    const bOwner = await who.as('owner', 'b');
    const repA = t.seed.a.rep.userId;

    const res = await bOwner.put(`/api/calendar/hours/${repA}`).send({ workHours: MY_HOURS });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: NOT_FOUND });

    const bPut = await bOwner.put('/api/calendar/settings').send({ ...DEFAULTS, travelBufferMinutes: 90 });
    expect(bPut.status).toBe(200);

    const aOwner = await who.as('owner');
    expect((await aOwner.get('/api/calendar/settings')).body).toEqual(DEFAULTS);
    expect((await bOwner.get('/api/calendar/settings')).body).toEqual({ ...DEFAULTS, travelBufferMinutes: 90 });
    expect(await dbAudit(t, B(), 'calendar.settings')).toHaveLength(1);
    expect(await dbAudit(t, A(), 'calendar.settings')).toHaveLength(0);
  });
});

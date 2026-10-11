import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { loginAs, makeTestApp, type TestApp } from './helpers.ts';

const APP_ORIGIN = 'https://app.roofline.test';
const URL = '/api/me/today-shown';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

/** The member's own marker, read straight from the table. */
async function shownOn(companyId: string, userId: string): Promise<string | null> {
  const result = await t.deps.pools.system.$client.query(
    'select last_today_shown_on::text as day from memberships where company_id = $1 and user_id = $2',
    [companyId, userId],
  );
  return (result.rows[0] as { day: string | null }).day;
}

describe('POST /api/me/today-shown', () => {
  test('shows Today once per company day', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);

    // Oct 12, 9:00 in Chicago.
    t.clock.set(new Date('2026-10-12T14:00:00Z'));
    const first = await owner.post(URL).send();
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ show: true });
    expect(await shownOn(t.seed.a.companyId, t.seed.a.owner.userId)).toBe('2026-10-12');

    expect((await owner.post(URL).send()).body).toEqual({ show: false });

    // Oct 13 04:00Z is still Oct 12 in Chicago (23:00).
    t.clock.set(new Date('2026-10-13T04:00:00Z'));
    expect((await owner.post(URL).send()).body).toEqual({ show: false });

    // Oct 13 06:00Z is Oct 13, 01:00 in Chicago: a new company day.
    t.clock.set(new Date('2026-10-13T06:00:00Z'));
    expect((await owner.post(URL).send()).body).toEqual({ show: true });
    expect(await shownOn(t.seed.a.companyId, t.seed.a.owner.userId)).toBe('2026-10-13');
  });

  test('keeps each member separate', async () => {
    t.clock.set(new Date('2026-10-12T14:00:00Z'));
    const owner = await loginAs(t.app, t.seed.a.owner);
    const office = await loginAs(t.app, t.seed.a.office);
    const rep = await loginAs(t.app, t.seed.a.rep);

    expect((await owner.post(URL).send()).body).toEqual({ show: true });
    // The office's first visit is unaffected by the owner's.
    expect((await office.post(URL).send()).body).toEqual({ show: true });
    // A rep gets the same.
    expect((await rep.post(URL).send()).body).toEqual({ show: true });

    expect((await owner.post(URL).send()).body).toEqual({ show: false });
    expect((await office.post(URL).send()).body).toEqual({ show: false });
    expect((await rep.post(URL).send()).body).toEqual({ show: false });

    // Nobody else's marker moved.
    expect(await shownOn(t.seed.a.companyId, t.seed.a.otherRep.userId)).toBeNull();
    expect(await shownOn(t.seed.b.companyId, t.seed.b.owner.userId)).toBeNull();
  });

  test('is atomic across tabs: of several simultaneous requests exactly one shows Today', async () => {
    t.clock.set(new Date('2026-10-12T14:00:00Z'));
    const owner = await loginAs(t.app, t.seed.a.owner);
    const results = await Promise.all(Array.from({ length: 6 }, () => owner.post(URL).send()));
    const shown = results.filter((r) => (r.body as { show: boolean }).show);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(shown).toHaveLength(1);
  });

  test('uses the zone of the member\'s own company', async () => {
    // Company B on Tokyo time: Oct 12 15:00Z is already Oct 13 00:00 there.
    await t.deps.pools.system.$client.query("update companies set timezone = 'Asia/Tokyo' where id = $1", [t.seed.b.companyId]);
    t.clock.set(new Date('2026-10-12T15:00:00Z'));
    const bOwner = await loginAs(t.app, t.seed.b.owner);
    expect((await bOwner.post(URL).send()).body).toEqual({ show: true });
    expect(await shownOn(t.seed.b.companyId, t.seed.b.owner.userId)).toBe('2026-10-13');
  });

  test('needs a session', async () => {
    const res = await request(t.app).post(URL).send();
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Please sign in.' });
  });

  test('refuses a cross-site origin', async () => {
    const owner = await loginAs(t.app, t.seed.a.owner);
    const res = await owner.post(URL).set('Origin', 'https://evil.example').send();
    expect(res.status).toBe(403);
    expect(await shownOn(t.seed.a.companyId, t.seed.a.owner.userId)).toBeNull();
    // The app's own origin passes.
    expect((await owner.post(URL).set('Origin', APP_ORIGIN).send()).status).toBe(200);
  });
});

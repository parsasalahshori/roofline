import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { createAppointment, createCustomer, createJob, createProperty, type TenantContext } from '@roofline/db';
import type { DailyForecast } from '../src/weather/source.ts';
import { Actors, inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/** 6 AM on Monday 2026-10-12 in Chicago (CDT, UTC-5). */
const SIX_AM = new Date('2026-10-12T11:00:00.000Z');
const MIDNIGHT = Date.parse('2026-10-12T05:00:00.000Z');
const DAY = 24 * 3_600_000;
const MON = 0;
const TUE = 1;
const WED = 2;

let t: TestApp;
let who: Actors;
const A = () => t.seed.a.companyId;
const ctxA = (): TenantContext => ({ companyId: A(), userId: null, role: 'system', canApproveSpend: false });

const date = (n: number): string => new Date(MIDNIGHT + n * DAY).toISOString().slice(0, 10);

type Outlook = {
  today: string;
  days: { date: string; risky: boolean; installs: number; icon: string; highF: number | null }[];
  atRisk: number;
  worstDate: string | null;
};

/** Eight forecast days from Monday; `chance` maps a day index to its rain chance. */
function week(chance: (n: number) => number | null): DailyForecast[] {
  return Array.from({ length: 8 }, (_, n) => ({
    date: date(n),
    highF: 70 + n,
    lowF: 50,
    summary: (chance(n) ?? 0) >= 60 ? 'Showers' : 'Sunny',
    precipChancePercent: chance(n),
  }));
}

let seq = 0;
/** An install on day `n` at a pinned address, which also gives the company its location. */
async function seedInstall(n: number): Promise<void> {
  const ctx = ctxA();
  const now = t.clock.now();
  seq += 1;
  await inCompany(t, A(), async (tx) => {
    const customer = await createCustomer(tx, ctx, { displayName: `Out Look${seq}`, firstName: 'Out', phones: [] }, { now });
    const property = await createProperty(
      tx,
      ctx,
      { customerId: customer.id, addressLine: `${3000 + seq} Oak St`, city: 'Austin', state: 'TX', zip: '78701', location: [-97.74, 30.27] },
      { now },
    );
    const job = await createJob(tx, ctx, { customerId: customer.id, propertyId: property.id }, { now });
    await createAppointment(
      tx,
      ctx,
      {
        kind: 'install',
        customerId: customer.id,
        propertyId: property.id,
        jobId: job.id,
        assignedUserId: t.seed.a.owner.userId,
        startsAt: new Date(MIDNIGHT + n * DAY),
        endsAt: new Date(MIDNIGHT + (n + 1) * DAY),
      },
      now,
    );
  });
}

describe('GET /api/weather/outlook', () => {
  beforeEach(async () => {
    t = await makeTestApp();
    who = new Actors(t);
    t.clock.set(SIX_AM);
  });

  test('needs a session', async () => {
    const res = await request(t.app).get('/api/weather/outlook');
    expect(res.status).toBe(401);
  });

  test('is null without a location', async () => {
    t.weather.dailyValue = week(() => 10);
    const res = await (await who.as('owner')).get('/api/weather/outlook');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outlook: null });
  });

  test('is null when the service has no forecast', async () => {
    await seedInstall(TUE);
    t.weather.dailyValue = null;
    const res = await (await who.as('owner')).get('/api/weather/outlook');
    expect(res.body).toEqual({ outlook: null });
  });

  test('six days from the company-local today, risky days from the rain threshold, installs counted on them', async () => {
    await seedInstall(TUE);
    await seedInstall(TUE);
    await seedInstall(WED); // a clear day: not at risk
    t.weather.dailyValue = week((n) => (n === TUE ? 80 : n === 4 ? 60 : 10));
    const res = await (await who.as('owner')).get('/api/weather/outlook');
    expect(res.status).toBe(200);
    const { outlook } = res.body as { outlook: Outlook };
    expect(outlook.today).toBe(date(MON));
    expect(outlook.days.map((d) => d.date)).toEqual([0, 1, 2, 3, 4, 5].map(date));
    expect(outlook.days.map((d) => d.risky)).toEqual([false, true, false, false, true, false]);
    expect(outlook.days.map((d) => d.installs)).toEqual([0, 2, 1, 0, 0, 0]);
    expect(outlook.days[1]).toMatchObject({ icon: 'rain', highF: 71 });
    expect(outlook.days[0]).toMatchObject({ icon: 'sun' });
    expect(outlook.atRisk).toBe(2);
    expect(outlook.worstDate).toBe(date(TUE));
    expect(t.weather.dailyCalls).toHaveLength(1);
  });

  test('past days are dropped and a day with no chance is not risky', async () => {
    await seedInstall(TUE);
    t.weather.dailyValue = [{ date: '2026-10-10', highF: 60, lowF: 40, summary: 'Rain', precipChancePercent: 90 }, ...week(() => null)];
    const { outlook } = (await (await who.as('owner')).get('/api/weather/outlook')).body as { outlook: Outlook };
    expect(outlook.days[0]!.date).toBe(date(MON));
    expect(outlook.days.some((d) => d.risky)).toBe(false);
    expect(outlook.atRisk).toBe(0);
    expect(outlook.worstDate).toBeNull();
  });

  test('a rep sees the forecast but no install counts; the forecast is kept for 30 minutes', async () => {
    await seedInstall(TUE);
    t.weather.dailyValue = week((n) => (n === TUE ? 80 : 10));
    const rep = await who.as('rep');
    const { outlook } = (await rep.get('/api/weather/outlook')).body as { outlook: Outlook };
    expect(outlook.days[1]).toMatchObject({ risky: true, installs: 0 });
    expect(outlook.atRisk).toBe(0);
    await (await who.as('owner')).get('/api/weather/outlook');
    expect(t.weather.dailyCalls).toHaveLength(1);
    t.clock.advance(31 * 60_000);
    await rep.get('/api/weather/outlook');
    expect(t.weather.dailyCalls).toHaveLength(2);
  });
});

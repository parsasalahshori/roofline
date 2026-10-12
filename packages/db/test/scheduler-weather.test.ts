import pg from 'pg';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { DEFAULT_WORK_HOURS } from '@roofline/shared';
import { createPools } from '../src/pools.ts';
import { insertTask } from '../src/repos/tasks.ts';
import {
  markMovedByTask,
  userBusyIntervals,
  weatherInstallCandidates,
  weatherSettings,
  weatherTaskOpen,
} from '../src/repos/scheduler-weather.ts';
import { agentTasks, appointments, calendarBusyBlocks, calendarConnections, customers, properties } from '../src/schema/index.ts';
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
  return { companyId: c.companyId, userId: null, role: 'owner', canApproveSpend: true };
}

const H = 3_600_000;
const T0 = new Date('2026-10-13T14:00:00Z');
const WIN = { from: new Date('2026-10-13T00:00:00Z'), to: new Date('2026-10-14T00:00:00Z') };

let n = 0;

async function ownerSql(text: string, params: unknown[]) {
  const client = new pg.Client({ connectionString: urls.owner });
  await client.connect();
  try {
    await client.query(text, params);
  } finally {
    await client.end();
  }
}

type Seed = {
  kind?: 'install' | 'inspection';
  status?: 'scheduled' | 'canceled';
  archived?: boolean;
  startsAt?: Date;
  endsAt?: Date;
  assigned?: boolean;
  geom?: boolean;
  doNotContact?: boolean;
  phones?: { e164: string; label?: string }[];
  firstName?: string;
};

/** A customer, property and appointment; returns the ids. */
async function makeAppt(c: SeededCompany, s: Seed = {}) {
  const ctx = ctxFor(c);
  n += 1;
  return withTenant(pools, ctx, async (tx) => {
    const [cust] = await tx
      .insert(customers)
      .values({
        companyId: c.companyId,
        displayName: 'Pat Customer',
        firstName: s.firstName ?? 'Pat',
        phones: s.phones ?? [{ e164: `+1402555${String(1000 + n)}`, label: 'mobile' }],
        doNotContact: s.doNotContact ?? false,
        createdByUserId: c.owner.userId,
      })
      .returning({ id: customers.id });
    const [prop] = await tx
      .insert(properties)
      .values({
        companyId: c.companyId,
        customerId: cust!.id,
        addressLine: `${n} Weather St`,
        city: 'Omaha',
        state: 'NE',
        zip: '68102',
        addressKey: `wx${n}`,
        ...(s.geom !== false && { geom: [-95.9345, 41.2565] as [number, number] }),
      })
      .returning({ id: properties.id });
    const startsAt = s.startsAt ?? T0;
    const [appt] = await tx
      .insert(appointments)
      .values({
        companyId: c.companyId,
        kind: s.kind ?? 'install',
        customerId: cust!.id,
        propertyId: prop!.id,
        assignedUserId: s.assigned === false ? null : c.rep.userId,
        startsAt,
        endsAt: s.endsAt ?? new Date(startsAt.getTime() + 2 * H),
        status: s.status ?? 'scheduled',
        ...(s.archived === true && { archivedAt: T0 }),
        createdByUserId: c.owner.userId,
      })
      .returning({ id: appointments.id });
    return { appointmentId: appt!.id, customerId: cust!.id, propertyId: prop!.id };
  });
}

async function candidates(c: SeededCompany) {
  const ctx = ctxFor(c);
  return withTenant(pools, ctx, (tx) => weatherInstallCandidates(tx, ctx, WIN));
}

async function makeWeatherTask(c: SeededCompany, createdAt: Date, status: 'draft' | 'done' | 'awaiting_owner') {
  const ctx = ctxFor(c);
  return withTenant(pools, ctx, async (tx) => {
    const [row] = await tx
      .insert(agentTasks)
      .values({ companyId: c.companyId, agent: 'scheduler', kind: 'weather_moves', title: 'Weather', status, createdAt, updatedAt: createdAt })
      .returning({ id: agentTasks.id });
    return row!.id;
  });
}

describe('weatherSettings', () => {
  test('defaults when there is no company_settings row, the row values when present', async () => {
    const ctx = ctxFor(seed.a);
    await ownerSql('delete from company_settings where company_id = $1', [seed.a.companyId]);
    expect(await withTenant(pools, ctx, (tx) => weatherSettings(tx, ctx))).toEqual({
      workHours: DEFAULT_WORK_HOURS,
      rainPct: 60,
      gustMph: 25,
    });
    const ctxB = ctxFor(seed.b);
    await ownerSql('update company_settings set weather_rain_pct = 40, weather_gust_mph = 18 where company_id = $1', [seed.b.companyId]);
    expect(await withTenant(pools, ctxB, (tx) => weatherSettings(tx, ctxB))).toEqual({
      workHours: DEFAULT_WORK_HOURS,
      rainPct: 40,
      gustMph: 18,
    });
  });
});

describe('weatherInstallCandidates', () => {
  test('returns only scheduled, unarchived, assigned installs with coordinates inside the window', async () => {
    const good = await makeAppt(seed.a, { firstName: 'Dana Marie' });
    await makeAppt(seed.a, { kind: 'inspection' });
    await makeAppt(seed.a, { status: 'canceled' });
    await makeAppt(seed.a, { archived: true });
    await makeAppt(seed.a, { geom: false });
    await makeAppt(seed.a, { assigned: false });
    await makeAppt(seed.a, { startsAt: new Date('2026-10-14T01:00:00Z') });
    await makeAppt(seed.a, { startsAt: new Date('2026-10-12T20:00:00Z') });
    await makeAppt(seed.b);
    const rows = await candidates(seed.a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      appointmentId: good.appointmentId,
      customerId: good.customerId,
      assignedUserId: seed.a.rep.userId,
      customerFirstName: 'Dana',
      textable: true,
    });
    expect(rows[0]!.lat).toBeCloseTo(41.2565, 4);
    expect(rows[0]!.lng).toBeCloseTo(-95.9345, 4);
  });

  test('textable is false for do-not-contact and for no phone', async () => {
    await makeAppt(seed.a, { doNotContact: true, startsAt: new Date('2026-10-13T14:00:00Z') });
    await makeAppt(seed.a, { phones: [], startsAt: new Date('2026-10-13T15:00:00Z') });
    await makeAppt(seed.a, { startsAt: new Date('2026-10-13T16:00:00Z') });
    const rows = await candidates(seed.a);
    expect(rows.map((r) => r.textable)).toEqual([false, false, true]);
  });
});

describe('weatherTaskOpen', () => {
  const since = new Date('2026-10-13T00:00:00Z');
  test('false when there is none', async () => {
    const ctx = ctxFor(seed.a);
    expect(await withTenant(pools, ctx, (tx) => weatherTaskOpen(tx, ctx, since))).toBe(false);
  });
  test('true for a task created after since', async () => {
    const ctx = ctxFor(seed.a);
    await makeWeatherTask(seed.a, new Date('2026-10-13T05:00:00Z'), 'done');
    expect(await withTenant(pools, ctx, (tx) => weatherTaskOpen(tx, ctx, since))).toBe(true);
  });
  test('true for an old task still awaiting the owner', async () => {
    const ctx = ctxFor(seed.a);
    await makeWeatherTask(seed.a, new Date('2026-10-01T05:00:00Z'), 'awaiting_owner');
    expect(await withTenant(pools, ctx, (tx) => weatherTaskOpen(tx, ctx, since))).toBe(true);
  });
  test('false for an old task that is done', async () => {
    const ctx = ctxFor(seed.a);
    await makeWeatherTask(seed.a, new Date('2026-10-01T05:00:00Z'), 'done');
    expect(await withTenant(pools, ctx, (tx) => weatherTaskOpen(tx, ctx, since))).toBe(false);
  });
});

describe('userBusyIntervals', () => {
  test('includes own appointments and busy blocks; excludes canceled, other users and the excluded one', async () => {
    const ctx = ctxFor(seed.a);
    const mine = await makeAppt(seed.a, { startsAt: new Date('2026-10-13T15:00:00Z') });
    const excluded = await makeAppt(seed.a, { startsAt: new Date('2026-10-13T18:00:00Z') });
    await makeAppt(seed.a, { status: 'canceled', startsAt: new Date('2026-10-13T20:00:00Z') });
    const other = await makeAppt(seed.a, { startsAt: new Date('2026-10-13T21:00:00Z') });
    await withTenant(pools, ctx, async (tx) => {
      await tx.update(appointments).set({ assignedUserId: seed.a.otherRep.userId }).where(eq(appointments.id, other.appointmentId));
      const [conn] = await tx
        .insert(calendarConnections)
        .values({
          companyId: seed.a.companyId,
          userId: seed.a.rep.userId,
          provider: 'google',
          accountEmail: 'rep@example.test',
          calendarId: 'primary',
          calendarName: 'Work',
          encryptedCredentials: Buffer.from('not-a-real-token'),
        })
        .returning({ id: calendarConnections.id });
      await tx.insert(calendarBusyBlocks).values({
        companyId: seed.a.companyId,
        connectionId: conn!.id,
        userId: seed.a.rep.userId,
        providerEventId: 'event-1',
        startsAt: new Date('2026-10-13T12:00:00Z'),
        endsAt: new Date('2026-10-13T13:00:00Z'),
      });
    });
    const got = await withTenant(pools, ctx, (tx) =>
      userBusyIntervals(tx, ctx, { userId: seed.a.rep.userId, ...WIN, excludeAppointmentId: excluded.appointmentId }),
    );
    expect(got.map((i) => [i.start.toISOString(), i.end.toISOString()])).toEqual([
      ['2026-10-13T12:00:00.000Z', '2026-10-13T13:00:00.000Z'],
      ['2026-10-13T15:00:00.000Z', '2026-10-13T17:00:00.000Z'],
    ]);
    expect(mine.appointmentId).toBeTruthy();
  });
});

describe('markMovedByTask', () => {
  test('sets moved_by_task_id', async () => {
    const ctx = ctxFor(seed.a);
    const a = await makeAppt(seed.a);
    const { taskId } = await withTenant(pools, ctx, (tx) =>
      insertTask(tx, ctx, { agent: 'scheduler', kind: 'weather_moves', title: 'Weather', steps: [] }, T0),
    );
    await withTenant(pools, ctx, (tx) => markMovedByTask(tx, ctx, a.appointmentId, taskId, T0));
    const [row] = await withTenant(pools, ctx, (tx) =>
      tx.select({ moved: appointments.movedByTaskId }).from(appointments).where(eq(appointments.id, a.appointmentId)),
    );
    expect(row!.moved).toBe(taskId);
  });
});

import { eq } from 'drizzle-orm';
import { companies } from '@roofline/db';
import { beforeEach, describe, expect, test } from 'vitest';
import { AGENT_JOB_HOURS, dueNow, localParts } from '../src/agents/schedule.ts';
import { agentJobSchedule } from '../src/jobs/scheduler/agent-jobs.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

const CHI = 'America/Chicago';
const LA = 'America/Los_Angeles';

/** Pure: no database. */
describe('dueNow', () => {
  test('the hours each job runs at', () => {
    expect(AGENT_JOB_HOURS).toEqual({ 'claims-daily': [10], 'scheduler-agenda': [18], 'scheduler-weather': [6, 14], 'followup-daily': [9] });
  });

  test('claims-daily: the window is [10:00, 10:15) company-local, either side of the 2026-11-01 clock change (Chicago)', () => {
    // Before the change (CDT, UTC-5).
    expect(dueNow('claims-daily', new Date('2026-10-31T15:00:00Z'), CHI, 15)).toBe(true);
    expect(dueNow('claims-daily', new Date('2026-10-31T16:00:00Z'), CHI, 15)).toBe(false);
    // After the change (CST, UTC-6): 10:00 local is 16:00Z.
    expect(dueNow('claims-daily', new Date('2026-11-01T15:59:00Z'), CHI, 15)).toBe(false);
    expect(dueNow('claims-daily', new Date('2026-11-01T16:00:00Z'), CHI, 15)).toBe(true);
    expect(dueNow('claims-daily', new Date('2026-11-01T16:14:00Z'), CHI, 15)).toBe(true);
    expect(dueNow('claims-daily', new Date('2026-11-01T16:15:00Z'), CHI, 15)).toBe(false);
    expect(dueNow('claims-daily', new Date('2026-11-01T15:00:00Z'), CHI, 15)).toBe(false);
  });

  test('claims-daily in Los Angeles on 2026-11-01', () => {
    expect(dueNow('claims-daily', new Date('2026-11-01T18:00:00Z'), LA, 15)).toBe(true);
    expect(dueNow('claims-daily', new Date('2026-11-01T17:00:00Z'), LA, 15)).toBe(false);
    expect(dueNow('claims-daily', new Date('2026-11-01T18:15:00Z'), LA, 15)).toBe(false);
    expect(dueNow('claims-daily', new Date('2026-10-31T17:00:00Z'), LA, 15)).toBe(true); // PDT
  });

  test('weather runs at 6 and 14, agenda at 18, follow-ups at 9', () => {
    expect(dueNow('scheduler-weather', new Date('2026-10-12T11:05:00Z'), CHI, 15)).toBe(true);
    expect(dueNow('scheduler-weather', new Date('2026-10-12T19:05:00Z'), CHI, 15)).toBe(true);
    expect(dueNow('scheduler-weather', new Date('2026-10-12T15:05:00Z'), CHI, 15)).toBe(false);
    expect(dueNow('scheduler-agenda', new Date('2026-10-12T23:00:00Z'), CHI, 15)).toBe(true);
    expect(dueNow('scheduler-agenda', new Date('2026-10-12T22:00:00Z'), CHI, 15)).toBe(false);
    expect(dueNow('followup-daily', new Date('2026-10-12T14:10:00Z'), CHI, 15)).toBe(true);
    expect(dueNow('followup-daily', new Date('2026-10-12T14:20:00Z'), CHI, 15)).toBe(false);
  });

  test('reminders use the hour passed in', () => {
    const at = new Date('2026-10-12T13:05:00Z'); // 08:05 CDT
    expect(dueNow('scheduler-reminders', at, CHI, 8)).toBe(true);
    expect(dueNow('scheduler-reminders', at, CHI, 15)).toBe(false);
    expect(dueNow('scheduler-reminders', new Date('2026-10-12T20:00:00Z'), CHI, 15)).toBe(true);
  });

  test('local midnight reads as hour 0, never 24', () => {
    expect(localParts(new Date('2026-10-12T05:30:00Z'), CHI)).toEqual({ localDate: '2026-10-12', hour: 0, minute: 30 });
  });
});

describe('agentJobSchedule', () => {
  let t: TestApp;
  const A = () => t.seed.a.companyId;
  const B = () => t.seed.b.companyId;

  beforeEach(async () => {
    t = await makeTestApp();
    await t.deps.pools.system.update(companies).set({ timezone: CHI }).where(eq(companies.id, A()));
    await t.deps.pools.system.update(companies).set({ timezone: LA }).where(eq(companies.id, B()));
  });

  test('sends the job only for the company whose local time is in the window', async () => {
    // 15:00Z: 10:00 in Chicago (CDT), 08:00 in Los Angeles.
    await agentJobSchedule('claims-daily')(t.deps, new Date('2026-10-12T15:00:00Z'));
    expect(t.jobs.sent).toEqual([
      { name: 'claims-daily', data: { companyId: A() }, singletonKey: `claims-daily:${A()}:2026-10-12` },
    ]);
  });

  test('a second run in the same slot sends with the same singletonKey (collapsed while the first is still queued)', async () => {
    const run = agentJobSchedule('claims-daily');
    await run(t.deps, new Date('2026-10-12T15:00:00Z'));
    await run(t.deps, new Date('2026-10-12T15:10:00Z'));
    expect(t.jobs.sent).toHaveLength(2);
    expect(t.jobs.sent[1]!.singletonKey).toBe(t.jobs.sent[0]!.singletonKey);
  });

  test('the weather key carries the local hour', async () => {
    await agentJobSchedule('scheduler-weather')(t.deps, new Date('2026-10-12T11:05:00Z')); // 06:05 CDT
    expect(t.jobs.sent).toEqual([
      { name: 'scheduler-weather', data: { companyId: A() }, singletonKey: `scheduler-weather:${A()}:2026-10-12T06` },
    ]);
  });

  test('reminders go out at the default hour of 15 when the company has not set one', async () => {
    await agentJobSchedule('scheduler-reminders')(t.deps, new Date('2026-10-12T20:00:00Z')); // 15:00 CDT, 13:00 PDT
    expect(t.jobs.sent.map((s) => [s.name, s.data.companyId])).toEqual([['scheduler-reminders', A()]]);
  });

  test('nothing is sent outside every window', async () => {
    await agentJobSchedule('followup-daily')(t.deps, new Date('2026-10-12T15:00:00Z'));
    expect(t.jobs.sent).toEqual([]);
  });
});

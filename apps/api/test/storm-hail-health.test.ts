import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AppDeps } from '../src/app.ts';

const newest = vi.hoisted(() => ({ value: null as Date | null }));
vi.mock('@roofline/db/system', () => ({ newestProcessedRunAt: async () => newest.value }));

const { hailHealth, staleThresholdMinutes } = await import('../src/jobs/scheduler/hail-health.ts');

const MINUTE = 60_000;
const sent: { to: string; subject: string; text: string }[] = [];
const errors: unknown[] = [];
const deps = {
  pools: { system: {} },
  mailer: { send: async (m: { to: string; subject: string; text: string }) => void sent.push(m) },
  config: { OPS_ALERT_EMAIL: 'ops@example.com' },
  logError: (err: unknown) => void errors.push(err),
} as unknown as AppDeps;

const SUMMER = new Date('2026-07-10T12:00:00Z');
const WINTER = new Date('2026-01-10T12:00:00Z');
const ageOf = (now: Date, minutes: number) => new Date(now.getTime() - minutes * MINUTE);

beforeEach(() => {
  sent.length = 0;
  errors.length = 0;
  newest.value = null;
});

describe('hailHealth', () => {
  test('staleThresholdMinutes is 180 from April to September and 720 otherwise', () => {
    expect(staleThresholdMinutes(new Date(Date.UTC(2026, 3, 1)))).toBe(180);
    expect(staleThresholdMinutes(new Date(Date.UTC(2026, 8, 30)))).toBe(180);
    expect(staleThresholdMinutes(new Date(Date.UTC(2026, 9, 1)))).toBe(720);
    expect(staleThresholdMinutes(new Date(Date.UTC(2026, 2, 31)))).toBe(720);
  });

  test('emails ops once when the newest processed run is over 3 hours old in summer', async () => {
    newest.value = ageOf(SUMMER, 181);
    await hailHealth(deps, SUMMER);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'ops@example.com', subject: 'Hail data is behind' });
    expect(sent[0]!.text).toContain(newest.value.toISOString());
  });

  test('does not email again on later ticks', async () => {
    newest.value = ageOf(SUMMER, 211);
    await hailHealth(deps, SUMMER);
    expect(sent).toHaveLength(0);
  });

  test('does not email when fresh', async () => {
    newest.value = ageOf(SUMMER, 100);
    await hailHealth(deps, SUMMER);
    expect(sent).toHaveLength(0);
  });

  test('uses 12 hours in winter', async () => {
    newest.value = ageOf(WINTER, 5 * 60);
    await hailHealth(deps, WINTER);
    expect(sent).toHaveLength(0);
    newest.value = ageOf(WINTER, 12 * 60 + 1);
    await hailHealth(deps, WINTER);
    expect(sent).toHaveLength(1);
  });

  test('no processed run sends nothing', async () => {
    await hailHealth(deps, SUMMER);
    expect(sent).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});

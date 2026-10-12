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
  config: { OPS_ALERT_EMAIL: 'ops@example.com', HAIL_ALERT_STALE_MINUTES_SEASON: 180, HAIL_ALERT_STALE_MINUTES_OFFSEASON: 720 },
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
  test('staleThresholdMinutes uses the season value from April to September and the off-season value otherwise', () => {
    const cfg = { HAIL_ALERT_STALE_MINUTES_SEASON: 100, HAIL_ALERT_STALE_MINUTES_OFFSEASON: 400 };
    expect(staleThresholdMinutes(new Date('2026-05-01T00:00:00Z'), cfg)).toBe(100);
    expect(staleThresholdMinutes(new Date('2026-04-01T00:00:00Z'), cfg)).toBe(100);
    expect(staleThresholdMinutes(new Date('2026-09-30T00:00:00Z'), cfg)).toBe(100);
    expect(staleThresholdMinutes(new Date('2026-10-01T00:00:00Z'), cfg)).toBe(400);
    expect(staleThresholdMinutes(new Date('2026-03-31T00:00:00Z'), cfg)).toBe(400);
  });

  test('emails ops once when the newest processed run is over 3 hours old in summer', async () => {
    newest.value = ageOf(SUMMER, 181);
    await hailHealth(deps, SUMMER);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'ops@example.com', subject: 'Hail data is behind' });
    expect(sent[0]!.text).toContain(newest.value.toISOString());
  });

  test('is silent an hour after the first alert and alerts again six hours later', async () => {
    newest.value = ageOf(SUMMER, 181);
    await hailHealth(deps, new Date(SUMMER.getTime() + 60 * MINUTE));
    expect(sent).toHaveLength(0);
    await hailHealth(deps, new Date(SUMMER.getTime() + 6 * 60 * MINUTE));
    expect(sent).toHaveLength(1);
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

  test('no processed run: alerts once the service has been up past the threshold', async () => {
    await hailHealth(deps, SUMMER, ageOf(SUMMER, 181));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('Hail data has never arrived');
    await hailHealth(deps, SUMMER, ageOf(SUMMER, 100));
    expect(sent).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });
});

import { cleanup, screen, within } from '@testing-library/react';
import { DEFAULT_WORK_HOURS } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schedule } from '../src/copy/schedule.ts';
import { ScheduleTab } from '../src/features/settings/ScheduleTab.tsx';
import { ACCOUNT, renderAt, SHELL_ROUTES, stubApi } from './helpers.tsx';

const SETTINGS = { workHours: DEFAULT_WORK_HOURS, travelBufferMinutes: 30, minNoticeMinutes: 120, stuckAfterDays: 14 };
const MY_HOURS = { workHours: DEFAULT_WORK_HOURS, custom: false };

const REP = { ...ACCOUNT, role: 'rep' as const };

/** The weekday names as the copy gives them, for finding each day's group. */
const DAY = schedule.weekday;

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** The company hours section, and the section of the person's own hours. */
const companyRegion = () => screen.getByRole('region', { name: schedule.companyTitle });
const yourRegion = () => screen.getByRole('region', { name: schedule.yourTitle });

describe('schedule tab', () => {
  it('owner saves company hours and settings', async () => {
    api = stubApi({
      ...SHELL_ROUTES,
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/calendar/settings': () => ({ body: SETTINGS }),
      'GET /api/calendar/my-hours': () => ({ body: MY_HOURS }),
      'PUT /api/calendar/settings': ({ body }) => ({ body }),
    });
    const { user } = renderAt(<ScheduleTab />, '/settings/schedule');
    const travel = await screen.findByLabelText(schedule.travelBuffer);
    await user.clear(travel);
    await user.type(travel, '45');
    await user.click(within(companyRegion()).getByRole('button', { name: schedule.save }));

    await screen.findByText(schedule.saved);
    expect(api.sent('PUT /api/calendar/settings')[0]).toEqual({
      workHours: DEFAULT_WORK_HOURS,
      travelBufferMinutes: 45,
      minNoticeMinutes: 120,
      stuckAfterDays: 14,
    });
  });

  it('the editor shows the API message for overlapping ranges', async () => {
    const message = 'mon: 08:00-12:00 overlaps 11:00-15:00';
    api = stubApi({
      ...SHELL_ROUTES,
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/calendar/settings': () => ({ body: SETTINGS }),
      'GET /api/calendar/my-hours': () => ({ body: MY_HOURS }),
      'PUT /api/calendar/settings': () => ({ status: 400, body: { error: message, field: 'workHours.mon' } }),
    });
    const { user } = renderAt(<ScheduleTab />, '/settings/schedule');
    await screen.findByRole('region', { name: schedule.companyTitle });

    const monday = within(companyRegion()).getByRole('group', { name: DAY.mon });
    await user.click(within(monday).getByRole('button', { name: schedule.addRange }));
    await user.click(within(companyRegion()).getByRole('button', { name: schedule.save }));

    await within(monday).findByText(message);
    expect(screen.getAllByText(message)).toHaveLength(1);
  });

  it('a rep sees company hours read-only', async () => {
    api = stubApi({
      ...SHELL_ROUTES,
      'GET /api/auth/me': () => ({ body: REP }),
      'GET /api/calendar/settings': () => ({ body: SETTINGS }),
      'GET /api/calendar/my-hours': () => ({ body: MY_HOURS }),
    });
    renderAt(<ScheduleTab />, '/settings/schedule');
    await screen.findByRole('region', { name: schedule.companyTitle });

    const company = companyRegion();
    expect(within(company).queryByRole('button', { name: schedule.save })).toBeNull();
    expect(within(company).getByText(schedule.ownerOnlyNote)).toBeInTheDocument();
    const monday = within(company).getByRole('group', { name: DAY.mon });
    expect(within(monday).getByRole('switch', { name: DAY.mon })).toBeDisabled();
    expect(within(monday).getByLabelText(`${DAY.mon} ${schedule.start}`)).toBeDisabled();
    expect(within(monday).getByRole('button', { name: schedule.addRange })).toBeDisabled();
    expect(within(company).getByLabelText(schedule.travelBuffer)).toHaveAttribute('readonly');
    // The person's own hours stay theirs to change
    expect(within(yourRegion()).getByRole('switch', { name: schedule.useCompanyHours })).toBeEnabled();
  });

  it('my hours toggle', async () => {
    api = stubApi({
      ...SHELL_ROUTES,
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/calendar/settings': () => ({ body: SETTINGS }),
      'GET /api/calendar/my-hours': () => ({ body: MY_HOURS }),
      'PUT /api/calendar/my-hours': ({ body }) => ({
        body: { workHours: DEFAULT_WORK_HOURS, custom: (body as { workHours: unknown }).workHours !== null },
      }),
    });
    const { user } = renderAt(<ScheduleTab />, '/settings/schedule');
    await screen.findByRole('region', { name: schedule.yourTitle });

    const toggle = within(yourRegion()).getByRole('switch', { name: schedule.useCompanyHours });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    // Switching off opens the editor, seeded with the hours; nothing is sent until Save
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    const mine = yourRegion();
    expect(within(mine).getByRole('group', { name: DAY.mon })).toBeInTheDocument();
    expect(api.count('PUT /api/calendar/my-hours')).toBe(0);
    await user.click(within(mine).getByRole('button', { name: schedule.save }));
    await screen.findByText(schedule.saved);
    expect(api.sent('PUT /api/calendar/my-hours')[0]).toEqual({ workHours: DEFAULT_WORK_HOURS });

    // Switching back on sends null at once: the company hours apply again
    await user.click(within(yourRegion()).getByRole('switch', { name: schedule.useCompanyHours }));
    await vi.waitFor(() => expect(api.sent('PUT /api/calendar/my-hours')).toHaveLength(2));
    expect(api.sent('PUT /api/calendar/my-hours')[1]).toEqual({ workHours: null });
  });
});

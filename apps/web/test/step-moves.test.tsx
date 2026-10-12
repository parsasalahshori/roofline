import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { StepView } from '../src/api/types.ts';
import { moveAppointmentKit, MoveAppointmentPreview } from '../src/features/approvals/steps/MoveAppointmentPreview.tsx';
import { ACCOUNT, SHELL_ROUTES, renderAt, stubApi } from './helpers.tsx';

afterEach(() => cleanup());

const MEMBER = 'b2c3d4e5-0000-4000-8000-000000000001';
const ZONE = 'America/Chicago';
const CTX = { zone: ZONE };
const ALL_DAY = {
  appointmentId: 'a1',
  start: '2026-11-04T06:00:00.000Z',
  end: '2026-11-05T06:00:00.000Z',
  userId: MEMBER,
  reason: 'Rain is forecast on Tuesday.',
};
const TIMED = { ...ALL_DAY, start: '2026-11-02T15:30:00.000Z', end: '2026-11-02T16:30:00.000Z' };

function step(payload: Record<string, unknown>): StepView {
  return {
    id: 's1',
    position: 1,
    type: 'move_appointment',
    approvalClass: 'schedule',
    enabled: true,
    version: 1,
    status: 'pending',
    preview: { title: 'x', lines: [] },
    canApprove: true,
    attempts: 0,
    result: null,
    errorPlain: null,
    payload,
  } as unknown as StepView;
}

function show(payload: Record<string, unknown>, members: { userId: string; name: string }[] = [{ userId: MEMBER.toUpperCase(), name: 'Dana Crew' }]) {
  stubApi({
    ...SHELL_ROUTES,
    'GET /api/company': () => ({ body: { timezone: ZONE } }),
    'GET /api/team': () => ({ body: { members, invites: [] } }),
  } as never);
  void ACCOUNT;
  return renderAt(<MoveAppointmentPreview step={step(payload)} canApprove={true} />);
}

describe('the move preview', () => {
  it('shows an all-day move with the day only, the reason and the member', async () => {
    show(ALL_DAY);
    const container = document.body;
    expect(await screen.findByText('Move the install to Wed, Nov 4')).toBeTruthy();
    expect(screen.getByText('Rain is forecast on Tuesday.')).toBeTruthy();
    expect(await screen.findByText('For Dana Crew')).toBeTruthy();
    expect(container.textContent).not.toMatch(/\d:\d\d/);
    expect(container.textContent).not.toMatch(/payload|step|json/i);
  });

  it('says a team member for an unknown id', async () => {
    show(ALL_DAY, []);
    expect(await screen.findByText('For a team member')).toBeTruthy();
  });

  it('shows the times of a timed span', async () => {
    show(TIMED);
    expect(await screen.findByText('Move the install to Mon, Nov 2, 9:30 AM to 10:30 AM')).toBeTruthy();
  });

  it('falls back when the start is unreadable', async () => {
    show({ ...ALL_DAY, start: 'soon', reason: '' });
    expect(await screen.findByText('Move an install')).toBeTruthy();
  });
});

describe('the move edit', () => {
  it('has the single day field', () => {
    expect(moveAppointmentKit.editFields(step(ALL_DAY), CTX)).toEqual([
      { id: 'date', label: 'New day', kind: 'text', value: '2026-11-04', help: 'Write the day as year-month-day, like 2026-11-02.' },
    ]);
  });

  it('round-trips an unchanged day', () => {
    expect(moveAppointmentKit.toPayload(step(ALL_DAY), { date: '2026-11-04' }, CTX)).toEqual(ALL_DAY);
    expect(moveAppointmentKit.toPayload(step(TIMED), { date: '2026-11-02' }, CTX)).toEqual(TIMED);
  });

  it('moves to a new day keeping the time of day, the length and the other keys', () => {
    const out = moveAppointmentKit.toPayload(step(TIMED), { date: '2026-11-09' }, CTX);
    expect(out).toEqual({ ...TIMED, start: '2026-11-09T15:30:00.000Z', end: '2026-11-09T16:30:00.000Z' });
    const day = moveAppointmentKit.toPayload(step(ALL_DAY), { date: '2026-11-10' }, CTX);
    expect(day).toEqual({ ...ALL_DAY, start: '2026-11-10T06:00:00.000Z', end: '2026-11-11T06:00:00.000Z' });
  });

  it('leaves the payload alone when something is unreadable', () => {
    expect(moveAppointmentKit.toPayload(step(ALL_DAY), { date: 'tomorrow' }, CTX)).toEqual(ALL_DAY);
    const bad = { ...ALL_DAY, start: 'soon' };
    expect(moveAppointmentKit.toPayload(step(bad), { date: '2026-11-10' }, CTX)).toEqual(bad);
  });

  it('checks the day', () => {
    const errors = (date: string) => moveAppointmentKit.fieldErrors?.(step(ALL_DAY), { date }, CTX) ?? {};
    expect(errors('2020-01-01')).toEqual({ date: 'Please pick today or a later day.' });
    expect(errors('tomorrow')).toEqual({ date: 'Please write the day as year-month-day, like 2026-11-02.' });
    expect(errors('2026-13-45')).toEqual({ date: 'Please write the day as year-month-day, like 2026-11-02.' });
    expect(errors('2099-01-01')).toEqual({});
  });
});

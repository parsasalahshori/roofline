import { describe, expect, it } from 'vitest';
import type { StepView } from '../src/api/types.ts';
import { createAppointmentKit } from '../src/features/approvals/steps/AppointmentPreview.tsx';
import { moveAppointmentKit } from '../src/features/approvals/steps/MoveAppointmentPreview.tsx';
import { zonedWallToInstant } from '../src/features/calendar/time.ts';

const ZONE = 'America/Chicago';
const CTX = { zone: ZONE };

function step(type: string, payload: Record<string, unknown>): StepView {
  return {
    id: 's1',
    position: 1,
    type,
    approvalClass: 'schedule',
    enabled: true,
    version: 1,
    status: 'pending',
    preview: { title: 'x', lines: [] },
    canApprove: true,
    attempts: 0,
    result: null,
    payload,
  } as unknown as StepView;
}

function create(date: string, start: string, end: string) {
  return createAppointmentKit.toPayload(
    step('create_appointment', { kind: 'inspection', start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' }),
    { date, start, end, note: '' },
    CTX,
  );
}

describe('create_appointment across a clock change', () => {
  it('keeps 9:30 AM on the spring-forward day', () => {
    const out = create('2026-03-08', '9:30 AM', '10:30 AM');
    expect(out.start).toBe('2026-03-08T14:30:00.000Z');
    expect(out.end).toBe('2026-03-08T15:30:00.000Z');
  });

  it('keeps 3:00 PM on the spring-forward day', () => {
    expect(create('2026-03-08', '3:00 PM', '4:00 PM').start).toBe('2026-03-08T20:00:00.000Z');
  });

  it('keeps 9:30 AM on the fall-back day', () => {
    const out = create('2026-11-01', '9:30 AM', '10:30 AM');
    expect(out.start).toBe('2026-11-01T15:30:00.000Z');
    expect(out.end).toBe('2026-11-01T16:30:00.000Z');
  });

  it('is unchanged on a normal day', () => {
    expect(create('2026-06-10', '9:30 AM', '10:30 AM').start).toBe('2026-06-10T14:30:00.000Z');
  });
});

describe('move_appointment across a clock change', () => {
  it('keeps 9:30 AM when moved onto the spring-forward day', () => {
    const out = moveAppointmentKit.toPayload(
      step('move_appointment', { appointmentId: 'a1', start: '2026-03-07T15:30:00.000Z', end: '2026-03-07T16:30:00.000Z' }),
      { date: '2026-03-08' },
      CTX,
    );
    expect(out.start).toBe('2026-03-08T14:30:00.000Z');
    expect(out.end).toBe('2026-03-08T15:30:00.000Z');
  });

  it('keeps 9:30 AM when moved onto the fall-back day', () => {
    const out = moveAppointmentKit.toPayload(
      step('move_appointment', { appointmentId: 'a1', start: '2026-10-31T14:30:00.000Z', end: '2026-10-31T15:30:00.000Z' }),
      { date: '2026-11-01' },
      CTX,
    );
    expect(out.start).toBe('2026-11-01T15:30:00.000Z');
    expect(out.end).toBe('2026-11-01T16:30:00.000Z');
  });
});

describe('zonedWallToInstant', () => {
  it('reads the wall clock on 23 and 25 hour days', () => {
    expect(zonedWallToInstant('2026-03-08', 9, 30, ZONE).toISOString()).toBe('2026-03-08T14:30:00.000Z');
    expect(zonedWallToInstant('2026-03-08', 0, 30, ZONE).toISOString()).toBe('2026-03-08T06:30:00.000Z');
    expect(zonedWallToInstant('2026-11-01', 9, 30, ZONE).toISOString()).toBe('2026-11-01T15:30:00.000Z');
    expect(zonedWallToInstant('2026-11-01', 23, 0, ZONE).toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(zonedWallToInstant('2026-06-10', 9, 30, ZONE).toISOString()).toBe('2026-06-10T14:30:00.000Z');
  });
});

// The company zone is America/Chicago; the test process runs in UTC, so every positioned instant proves the zone is used.
vi.hoisted(() => {
  process.env.TZ = 'UTC';
});

import type { AppointmentView } from '@roofline/shared';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppointmentForm, zonedWallToInstant } from '../src/features/appointments/AppointmentForm.tsx';
import type { Slot } from '../src/features/appointments/types.ts';
import { appointments } from '../src/copy/appointments.ts';
import { ACCOUNT, renderAt, type Routes, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const COMPANY_BODY = {
  id: 'c1',
  name: 'Summit Roofing',
  slug: 'summit-roofing',
  status: 'active',
  legalName: null,
  phone: null,
  email: null,
  website: null,
  addressStreet: null,
  addressCity: null,
  addressState: null,
  addressZip: null,
  timezone: 'America/Chicago',
  logoUrl: null,
  located: false,
  serviceAreaMiles: null,
};

const TEAM_BODY = {
  members: [
    { id: 'm1', userId: 'u1', name: 'Sam Roofer', email: 'sam@example.com', role: 'owner', canApproveSpend: true, status: 'active' },
    { id: 'm2', userId: 'u2', name: 'Lee Office', email: 'lee@example.com', role: 'office', canApproveSpend: false, status: 'active' },
    { id: 'm3', userId: 'u3', name: 'Old Hand', email: 'old@example.com', role: 'rep', canApproveSpend: false, status: 'disabled' },
  ],
  invites: [],
};

/** The job the window opens from: Dana Price's home on Oak Street, job j1, customer c1, home p1. */
const JOB_VIEW = {
  job: { id: 'j1', customerId: 'c1', customerName: 'Dana Price', propertyId: 'p1', addressLine: '12 Oak St', stage: 'lead' },
  customer: { id: 'c1', displayName: 'Dana Price', phone: null, email: null },
  home: { id: 'p1', addressLine: '12 Oak St', city: 'Austin', state: 'TX', zip: '78701', located: true, jobs: [] },
  appointments: [],
  quotes: [],
  tasks: [],
  can: { edit: true, seeValue: true, archive: false },
};

const SAVED: AppointmentView = {
  id: 'a1',
  kind: 'inspection',
  title: 'Inspection',
  status: 'scheduled',
  startsAt: '2026-10-13T19:00:00.000Z',
  endsAt: '2026-10-13T20:00:00.000Z',
  allDay: false,
  assigned: { userId: 'u1', name: 'Sam Roofer' },
  jobId: 'j1',
  customerId: 'c1',
  customerName: 'Dana Price',
  propertyId: 'p1',
  addressLine: '12 Oak St',
  notes: null,
  source: 'manual',
  sync: 'none',
  canEdit: true,
};

/**
 * Availability keys carry the window's dates, which depend on the clock. Any GET of the
 * availability path answers `slots`; every other key is matched exactly as the stub does.
 */
function withAvailability(routes: Routes, slots: Slot[]): Routes {
  return new Proxy(routes, {
    get(target, prop) {
      if (typeof prop === 'string' && prop.startsWith('GET /api/calendar/availability')) {
        return () => ({ body: { slots } });
      }
      return Reflect.get(target, prop) as unknown;
    },
  });
}

function setup(extra: Routes = {}, options: { slots?: Slot[]; role?: 'owner' | 'rep' } = {}) {
  const account = options.role === 'rep' ? { ...ACCOUNT, role: 'rep' as const } : ACCOUNT;
  api = stubApi(
    withAvailability(
      {
        'GET /api/auth/me': () => ({ body: account }),
        'GET /api/company': () => ({ body: COMPANY_BODY }),
        'GET /api/team': () => ({ body: TEAM_BODY }),
        'GET /api/jobs/j1/view': () => ({ body: JOB_VIEW }),
        ...extra,
      },
      options.slots ?? [],
    ),
  );
  return api;
}

const SAVE_OK = () => ({ status: 201, body: { appointment: SAVED, warnings: [], jobMoved: false } });

describe('zonedWallToInstant', () => {
  it('turns a Chicago wall clock on a normal day into the instant', () => {
    expect(zonedWallToInstant('2026-10-13', '14:00', 'America/Chicago').toISOString()).toBe('2026-10-13T19:00:00.000Z');
  });

  it('is right on the spring-forward day 2026-03-08', () => {
    expect(zonedWallToInstant('2026-03-08', '09:00', 'America/Chicago').toISOString()).toBe('2026-03-08T14:00:00.000Z');
  });

  it('is right on the fall-back day 2026-11-01', () => {
    expect(zonedWallToInstant('2026-11-01', '09:00', 'America/Chicago').toISOString()).toBe('2026-11-01T15:00:00.000Z');
  });
});

describe('Appointment form', () => {
  it('prefills the customer and home from ?jobId=&kind=inspection', async () => {
    setup();
    renderAt(<AppointmentForm onDone={vi.fn()} />, '/appointments/new?jobId=j1&kind=inspection');

    expect(await screen.findByText('Dana Price')).toBeInTheDocument();
    expect(screen.getByText('12 Oak St')).toBeInTheDocument();
    expect(screen.getByLabelText(appointments.kindLabel)).toHaveValue('inspection');
    expect(api.count('GET /api/jobs/j1/view')).toBe(1);
  });

  it('prefills date, time and a single person from ?start=&people=', async () => {
    setup();
    renderAt(<AppointmentForm onDone={vi.fn()} />, '/calendar/new?start=2026-10-13T19%3A00%3A00.000Z&people=u2&kind=other');

    expect(await screen.findByLabelText(appointments.dateLabel)).toHaveValue('2026-10-13');
    expect(screen.getByLabelText(appointments.timeLabel)).toHaveValue('14:00');
    await waitFor(() => expect(screen.getByLabelText(appointments.personLabel)).toHaveValue('u2'));
  });

  it('shows the server message when a save fails with an ApiError', async () => {
    setup({ 'POST /api/appointments': () => ({ status: 422, body: { error: 'That time is outside the work week.' } }) });
    const { user } = renderAt(<AppointmentForm onDone={vi.fn()} />, '/appointments/new?jobId=j1&kind=inspection');
    await screen.findByText('Dana Price');
    fireEvent.change(screen.getByLabelText(appointments.timeLabel), { target: { value: '14:00' } });
    await user.click(screen.getByRole('button', { name: appointments.save }));
    expect(await screen.findByText('That time is outside the work week.')).toBeInTheDocument();
  });

  it('picking a suggestion fills date, time and person', async () => {
    setup({}, { slots: [{ start: '2026-10-13T19:00:00.000Z', end: '2026-10-13T19:30:00.000Z', userIds: ['u1'] }] });
    const { user } = renderAt(<AppointmentForm onDone={vi.fn()} />, '/appointments/new?jobId=j1&kind=inspection');
    // The job prefills the home, which the suggestions are asked for: wait for it so the slot is not re-asked under the click
    await screen.findByText('Dana Price');

    await user.click(await screen.findByRole('button', { name: /2:00 PM/ }));

    expect(screen.getByLabelText(appointments.dateLabel)).toHaveValue('2026-10-13');
    expect(screen.getByLabelText(appointments.timeLabel)).toHaveValue('14:00');
    expect(screen.getByLabelText(appointments.personLabel)).toHaveValue('u1');
  });

  it('save posts the right body with ISO instants from company-zone input', async () => {
    const onDone = vi.fn();
    setup({ 'POST /api/appointments': SAVE_OK });
    const { user } = renderAt(<AppointmentForm onDone={onDone} />, '/appointments/new?jobId=j1&kind=inspection');
    await screen.findByText('Dana Price');

    fireEvent.change(screen.getByLabelText(appointments.dateLabel), { target: { value: '2026-10-13' } });
    fireEvent.change(screen.getByLabelText(appointments.timeLabel), { target: { value: '14:00' } });
    await user.click(screen.getByRole('button', { name: appointments.save }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(SAVED));
    expect(api.sent('POST /api/appointments')).toEqual([
      {
        kind: 'inspection',
        startsAt: '2026-10-13T19:00:00.000Z',
        endsAt: '2026-10-13T20:00:00.000Z',
        allDay: false,
        jobId: 'j1',
        customerId: 'c1',
        propertyId: 'p1',
        assignedUserId: 'u1',
      },
    ]);
  });

  it('reschedule PATCHes the new start with the same length', async () => {
    const onDone = vi.fn();
    setup({ 'PATCH /api/appointments/a1': () => ({ body: { appointment: SAVED, warnings: [] } }) });
    const { user } = renderAt(<AppointmentForm existing={SAVED} onDone={onDone} />, '/appointments/new');
    await screen.findByLabelText(appointments.dateLabel);

    fireEvent.change(screen.getByLabelText(appointments.dateLabel), { target: { value: '2026-10-20' } });
    await user.click(screen.getByRole('button', { name: appointments.save }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.sent('PATCH /api/appointments/a1')[0]).toMatchObject({
      kind: 'inspection',
      allDay: false,
      startsAt: '2026-10-20T19:00:00.000Z',
      endsAt: '2026-10-20T20:00:00.000Z',
    });
  });

  it('shows the warnings banner after save with Keep it and Change time', async () => {
    const onDone = vi.fn();
    setup({
      'POST /api/appointments': () => ({
        status: 201,
        body: { appointment: SAVED, warnings: ['Sam has another visit then.'], jobMoved: false },
      }),
    });
    const { user } = renderAt(<AppointmentForm onDone={onDone} />, '/appointments/new?jobId=j1&kind=inspection');
    await screen.findByText('Dana Price');
    fireEvent.change(screen.getByLabelText(appointments.dateLabel), { target: { value: '2026-10-13' } });
    fireEvent.change(screen.getByLabelText(appointments.timeLabel), { target: { value: '14:00' } });
    await user.click(screen.getByRole('button', { name: appointments.save }));

    expect(await screen.findByText('Sam has another visit then.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: appointments.keepIt })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: appointments.changeTime })).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: appointments.keepIt }));
    expect(onDone).toHaveBeenCalledWith(SAVED);
  });

  it('toasts when the job moved', async () => {
    const onDone = vi.fn();
    setup({
      'POST /api/appointments': () => ({ status: 201, body: { appointment: SAVED, warnings: [], jobMoved: true } }),
    });
    const { user } = renderAt(<AppointmentForm onDone={onDone} />, '/appointments/new?jobId=j1&kind=inspection');
    await screen.findByText('Dana Price');
    fireEvent.change(screen.getByLabelText(appointments.dateLabel), { target: { value: '2026-10-13' } });
    fireEvent.change(screen.getByLabelText(appointments.timeLabel), { target: { value: '14:00' } });
    await user.click(screen.getByRole('button', { name: appointments.save }));

    expect(await screen.findByText('Moved the job to Inspection.')).toBeInTheDocument();
    expect(onDone).toHaveBeenCalledWith(SAVED);
  });

  it('install shows a date range and posts all-day', async () => {
    const onDone = vi.fn();
    setup({ 'POST /api/appointments': SAVE_OK });
    const { user } = renderAt(<AppointmentForm onDone={onDone} />, '/appointments/new?kind=install');

    expect(await screen.findByLabelText(appointments.startDateLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(appointments.endDateLabel)).toBeInTheDocument();
    expect(screen.queryByLabelText(appointments.timeLabel)).toBeNull();

    fireEvent.change(screen.getByLabelText(appointments.startDateLabel), { target: { value: '2026-10-13' } });
    fireEvent.change(screen.getByLabelText(appointments.endDateLabel), { target: { value: '2026-10-14' } });
    await user.click(screen.getByRole('button', { name: appointments.save }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(SAVED));
    expect(api.sent('POST /api/appointments')).toEqual([
      {
        kind: 'install',
        allDay: true,
        startsAt: '2026-10-13T05:00:00.000Z',
        endsAt: '2026-10-15T05:00:00.000Z',
        assignedUserId: 'u1',
      },
    ]);
  });

  it('a rep cannot pick another person', async () => {
    setup({}, { role: 'rep' });
    renderAt(<AppointmentForm onDone={vi.fn()} />, '/appointments/new?kind=other');

    const person = await screen.findByLabelText(appointments.personLabel);
    expect(person.querySelectorAll('option')).toHaveLength(1);
    expect(person).toBeDisabled();
    expect(person).toHaveValue('u1');
  });
});

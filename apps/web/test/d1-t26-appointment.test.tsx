import type { AppointmentView } from '@roofline/shared';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appointments } from '../src/copy/appointments.ts';
import { AppointmentDetail } from '../src/features/appointments/AppointmentDetail.tsx';
import { renderAt, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const BASE: AppointmentView = {
  id: 'a1',
  kind: 'inspection',
  title: 'Roof check',
  status: 'scheduled',
  startsAt: '2026-10-13T19:00:00Z',
  endsAt: '2026-10-13T20:00:00Z',
  allDay: false,
  assigned: null,
  jobId: null,
  customerId: null,
  customerName: null,
  propertyId: null,
  addressLine: null,
  notes: null,
  source: 'manual',
  sync: 'none',
  confirmedAt: null,
  confirmedVia: null,
  canEdit: false,
} as AppointmentView;

function show(source: AppointmentView['source']) {
  api = stubApi({
    'GET /api/company': () => ({ body: { timezone: 'America/Chicago' } }),
    'GET /api/calendar/connection': () => ({ body: { provider: null, status: null, configured: { google: true, microsoft: true } } }),
  });
  renderAt(<AppointmentDetail appointment={{ ...BASE, source }} onReschedule={vi.fn()} />, '/calendar/appointments/a1');
}

describe('appointment source line', () => {
  it('shows Booked by Front Desk for a front desk booking', async () => {
    show('front_desk');
    expect(await screen.findByText(appointments.bookedByFrontDesk)).toBeInTheDocument();
  });

  it('does not show it for a manual booking', async () => {
    show('manual');
    await screen.findByRole('heading', { name: 'Roof check' });
    expect(screen.queryByText(appointments.bookedByFrontDesk)).not.toBeInTheDocument();
  });
});

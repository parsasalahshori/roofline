import { describe, expect, test } from 'vitest';
import type { AppointmentView } from '@roofline/shared';
import { eventInputFor } from '../src/calendar/event-text.ts';

const NOTES = 'Call 402-555-0100 or maria@example.com';
const URL = 'https://app.roofline.test/jobs/J1';

function view(over: Partial<AppointmentView> = {}): AppointmentView {
  return {
    id: 'A1',
    kind: 'inspection',
    title: 'Inspection',
    status: 'scheduled',
    startsAt: '2030-01-10T16:00:00.000Z',
    endsAt: '2030-01-10T17:00:00.000Z',
    allDay: false,
    assigned: null,
    jobId: 'J1',
    customerId: 'C1',
    customerName: 'Maria Lopez',
    propertyId: 'P1',
    addressLine: '101 Oak St',
    notes: NOTES,
    source: 'manual',
    sync: 'none',
    canEdit: true,
    ...over,
  };
}

describe('eventInputFor', () => {
  test('builds title, location, description, times and zone', () => {
    const e = eventInputFor(view(), { jobUrl: URL, timeZone: 'America/Chicago' });
    expect(e.title).toBe('Inspection — Maria Lopez');
    expect(e.location).toBe('101 Oak St');
    expect(e.description).toBe(`Open in Roofline: ${URL}`);
    expect(e.start).toEqual(new Date('2030-01-10T16:00:00.000Z'));
    expect(e.end).toEqual(new Date('2030-01-10T17:00:00.000Z'));
    expect(e.timeZone).toBe('America/Chicago');
  });

  test('never leaks phone, email or notes', () => {
    const s = JSON.stringify(eventInputFor(view(), { jobUrl: URL, timeZone: 'UTC' }));
    expect(s).not.toContain('402-555-0100');
    expect(s).not.toContain('maria@example.com');
    expect(s).not.toContain(NOTES);
  });

  test('null fields', () => {
    const e = eventInputFor(view({ customerName: null, addressLine: null }), { jobUrl: null, timeZone: 'UTC' });
    expect(e.title).toBe('Inspection');
    expect(e.location).toBeNull();
    expect(e.description).toBe('Open in Roofline');
  });

  test('allDay passes through', () => {
    expect(eventInputFor(view({ allDay: true }), { jobUrl: null, timeZone: 'UTC' }).allDay).toBe(true);
  });
});

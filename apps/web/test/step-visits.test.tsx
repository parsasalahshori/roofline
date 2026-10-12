import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepView } from '../src/api/types.ts';
import { AppointmentPreview, createAppointmentKit } from '../src/features/approvals/steps/AppointmentPreview.tsx';
import { ClaimPacketPreview, claimPacketKit } from '../src/features/approvals/steps/ClaimPacketPreview.tsx';
import { renderAt, stubApi } from './helpers.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const JOB = '5f1c9a2e-3b4d-4c6e-8f70-1a2b3c4d5e6f';
const USER = 'AAAA1111-3b4d-4c6e-8f70-1a2b3c4d5e6f';
const ctx = { zone: 'America/Chicago' };

function step(type: StepView['type'], payload: Record<string, unknown>, title = 'Server title'): StepView {
  return {
    id: 's1',
    position: 1,
    type,
    approvalClass: 'internal',
    enabled: true,
    version: 1,
    status: 'pending',
    preview: { title, lines: [] },
    canApprove: true,
    attempts: 0,
    result: null,
    errorPlain: null,
    payload,
  } as StepView;
}

const packet = () => step('build_claim_packet', { jobId: JOB });
const visit = (over: Record<string, unknown> = {}) =>
  step('create_appointment', {
    jobId: JOB,
    kind: 'adjuster',
    start: '2026-11-02T15:30:00.000Z',
    end: '2026-11-02T16:30:00.000Z',
    userId: USER.toLowerCase(),
    note: 'Gate code 1234',
    ...over,
  });

function routes() {
  return stubApi({
    'GET /api/company': () => ({ body: { timezone: 'America/Chicago' } }),
    'GET /api/team': () => ({ body: { members: [{ id: 'm1', userId: USER.toLowerCase(), name: 'Dana Field', email: 'd@example.com', role: 'rep', canApproveSpend: false, status: 'active', stormAlertEmail: false }], invites: [] } }),
  });
}

describe('the claim packet kit', () => {
  it('shows the blurb and a link to the job', () => {
    renderAt(<ClaimPacketPreview step={packet()} canApprove={true} />);
    expect(screen.getByText(/Builds the claim packet PDF/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the job' }).getAttribute('href')).toBe(`/jobs/${JOB}`);
  });
  it('skips the link without a job', () => {
    renderAt(<ClaimPacketPreview step={step('build_claim_packet', {})} canApprove={true} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
  it('has no fields, keeps the payload and the server title', () => {
    expect(claimPacketKit.editFields(packet())).toEqual([]);
    expect(claimPacketKit.toPayload(packet(), {})).toEqual({ jobId: JOB });
    expect(claimPacketKit.review(packet()).title).toBe('Server title');
  });
});

describe('the appointment preview', () => {
  it('shows kind, time range, member and note', async () => {
    routes();
    renderAt(<AppointmentPreview step={visit()} canApprove={true} />);
    expect(screen.getByText('Adjuster visit')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Mon, Nov 2 · 9:30 AM to 10:30 AM')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('For Dana Field')).toBeTruthy());
    expect(screen.getByText('Gate code 1234')).toBeTruthy();
    expect(document.body.textContent ?? '').not.toMatch(/payload|step|json/i);
  });
  it('shows Inspection and a fallback member name', async () => {
    routes();
    renderAt(<AppointmentPreview step={visit({ kind: 'inspection', userId: 'nobody', note: '' })} canApprove={true} />);
    expect(screen.getByText('Inspection')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Mon, Nov 2 · 9:30 AM to 10:30 AM')).toBeTruthy());
    expect(screen.getByText('For a team member')).toBeTruthy();
  });
  it('shows no time line when the times are unreadable', () => {
    routes();
    renderAt(<AppointmentPreview step={visit({ start: 'x' })} canApprove={true} />);
    expect(screen.queryByText(/ to /)).toBeNull();
  });
});

describe('the appointment edit fields', () => {
  const initial = (s: StepView) =>
    Object.fromEntries(createAppointmentKit.editFields(s, ctx).map((f) => [f.id, f.value])) as Record<string, string>;

  it('lists the fields', () => {
    const fields = createAppointmentKit.editFields(visit(), ctx);
    expect(fields.map((f) => [f.id, f.value])).toEqual([
      ['date', '2026-11-02'],
      ['start', '9:30 AM'],
      ['end', '10:30 AM'],
      ['note', 'Gate code 1234'],
    ]);
    expect(fields[1]?.help).toBe('For example 9:30 AM.');
  });
  it('round trips', () => {
    const s = visit();
    expect(createAppointmentKit.toPayload(s, initial(s), ctx)).toEqual(s.payload);
  });
  it('changes only end, or only note', () => {
    const s = visit();
    expect(createAppointmentKit.toPayload(s, { ...initial(s), end: '11:00am' }, ctx)).toEqual({
      ...s.payload,
      end: '2026-11-02T17:00:00.000Z',
    });
    expect(createAppointmentKit.toPayload(s, { ...initial(s), note: 'Call first' }, ctx)).toEqual({ ...s.payload, note: 'Call first' });
  });
  it('accepts 24 hour times and keeps originals when unreadable', () => {
    const s = visit();
    expect(createAppointmentKit.toPayload(s, { ...initial(s), start: '14:30', end: '15:30' }, ctx)).toMatchObject({
      start: '2026-11-02T20:30:00.000Z',
    });
    expect(createAppointmentKit.toPayload(s, { ...initial(s), end: 'soon' }, ctx).end).toBe('2026-11-02T16:30:00.000Z');
  });
  it('reports errors', () => {
    const s = visit();
    const errors = (v: Record<string, string>) => createAppointmentKit.fieldErrors?.(s, { ...initial(s), ...v }, ctx);
    expect(errors({})).toEqual({});
    expect(errors({ end: '9:00 AM' })).toEqual({ end: 'The end must be after the start.' });
    expect(errors({ start: 'noon' })).toEqual({ start: 'Please enter the time like 9:30 AM.' });
    expect(errors({ date: '2026-02-31' })).toEqual({ date: 'Please enter the date as year-month-day, like 2026-11-02.' });
    expect(errors({ date: 'tomorrow' })?.date).toBeTruthy();
    expect(errors({ note: 'x'.repeat(501) })).toEqual({ note: 'Please keep the note to 500 characters or fewer.' });
  });
});

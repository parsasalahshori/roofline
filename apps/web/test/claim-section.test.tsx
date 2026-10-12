import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { displayUsPhone, type ClaimView, type JobClaimResponse } from '@roofline/shared';
import { claims } from '../src/copy/claims.ts';
import { ClaimSection } from '../src/features/job/ClaimSection.tsx';
import { type Routes, renderAt, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CLAIM: ClaimView = {
  id: 'cl1',
  jobId: 'j1',
  insurer: 'Acme Mutual',
  claimNumber: 'CL-7',
  dateOfLoss: '2026-09-30',
  status: 'inspected',
  adjusterName: 'Dana Lee',
  adjusterPhone: '+15125550123',
  adjusterEmail: 'dana@example.com',
  adjusterAppointmentId: null,
  deductibleCents: 100000,
  notes: 'Roof only',
  statusChangedAt: '2026-10-14T15:00:00.000Z',
  events: [
    { from: null, to: 'filed', by: 'user', byName: 'Sam', at: '2026-10-12T15:00:00.000Z' },
    { from: 'filed', to: 'inspected', by: 'agent', byName: null, at: '2026-10-14T15:00:00.000Z' },
  ],
};
const INTAKE = { insurer: 'Acme Mutual', claimNumber: 'CL-7', dateOfLoss: '2026-09-30', description: 'Hail', adjusterVisitAt: null };

function open(data: JobClaimResponse, extra: Routes = {}) {
  api = stubApi({
    'GET /api/company': () => ({ body: { id: 'c1', name: 'Summit Roofing', timezone: 'America/Chicago' } }),
    'GET /api/jobs/j1/claim': () => ({ body: data }),
    ...extra,
  });
  return renderAt(<ClaimSection jobId="j1" />);
}

const putSaved = { 'PUT /api/jobs/j1/claim': () => ({ body: { ...CLAIM, claimNumber: 'CL-8' } }) };

async function openEdit(user: ReturnType<typeof renderAt>['user']) {
  await user.click(await screen.findByRole('button', { name: claims.edit }));
  return within(await screen.findByRole('dialog'));
}

describe('claim section', () => {
  it('with no claim and no intake offers to add details', async () => {
    open({ claim: null, intake: null });
    expect(await screen.findByText(claims.none)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: claims.addDetails })).toBeInTheDocument();
  });

  it('with only an intake shows its line and pre-fills the form', async () => {
    const { user } = open({ claim: null, intake: INTAKE });
    expect(await screen.findByText(claims.intakeLine('Acme Mutual', 'CL-7'))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: claims.addDetails }));
    const form = within(await screen.findByRole('dialog'));
    expect(form.getByLabelText(claims.insurerLabel)).toHaveValue('Acme Mutual');
    expect(form.getByLabelText(claims.claimNumberLabel)).toHaveValue('CL-7');
  });

  it('an intake without a claim number says it was not given', async () => {
    open({ claim: null, intake: { ...INTAKE, claimNumber: null } });
    expect(await screen.findByText(claims.intakeLine('Acme Mutual', null))).toHaveTextContent('claim not given');
  });

  it('shows the claim, its history, and no phone or email links', async () => {
    open({ claim: CLAIM, intake: null });
    expect(await screen.findByText(claims.status.inspected)).toBeInTheDocument();
    expect(screen.getByText(displayUsPhone('+15125550123'))).toBeInTheDocument();
    expect(screen.getByText('dana@example.com')).toBeInTheDocument();
    expect(screen.getByText(/1,000/)).toBeInTheDocument();
    expect(screen.getByText('Roof only')).toBeInTheDocument();
    expect(screen.getByText('Filed · by Sam · Oct 12')).toBeInTheDocument();
    expect(screen.getByText('Inspected · by the Claims agent · Oct 14')).toBeInTheDocument();
    expect(document.querySelectorAll('a[href^="tel:"], a[href^="mailto:"]').length).toBe(0);
  });

  it('a first save from an intake sends a cleared pre-filled field as null, so it is not filled back', async () => {
    const { user } = open({ claim: null, intake: INTAKE }, putSaved);
    await user.click(await screen.findByRole('button', { name: claims.addDetails }));
    const form = within(await screen.findByRole('dialog'));
    await user.clear(form.getByLabelText(claims.claimNumberLabel));
    await user.click(form.getByRole('button', { name: claims.save }));

    expect(await screen.findByText(claims.saved)).toBeInTheDocument();
    const [sent] = api.sent('PUT /api/jobs/j1/claim') as Record<string, unknown>[];
    expect(sent).toMatchObject({ insurer: 'Acme Mutual', claimNumber: null });
  });

  it('after a save the section shows the saved claim', async () => {
    const { user } = open({ claim: CLAIM, intake: null }, putSaved);
    const form = await openEdit(user);
    const number = form.getByLabelText(claims.claimNumberLabel);
    await user.clear(number);
    await user.type(number, 'CL-8');
    await user.click(form.getByRole('button', { name: claims.save }));

    expect(await screen.findByText('CL-8')).toBeInTheDocument();
  });

  it('saves only the changed fields and shows the toast', async () => {
    const { user } = open({ claim: CLAIM, intake: null }, putSaved);
    const form = await openEdit(user);
    const number = form.getByLabelText(claims.claimNumberLabel);
    await user.clear(number);
    await user.type(number, 'CL-8');
    await user.click(form.getByRole('button', { name: claims.save }));

    expect(await screen.findByText(claims.saved)).toBeInTheDocument();
    expect(api.sent('PUT /api/jobs/j1/claim')).toEqual([{ claimNumber: 'CL-8' }]);
  });

  it('shows a rejected field under that field and no toast', async () => {
    const message = 'Please keep that to 200 characters or fewer.';
    const { user } = open(
      { claim: CLAIM, intake: null },
      { 'PUT /api/jobs/j1/claim': () => ({ status: 400, body: { error: message, field: 'claimNumber' } }) },
    );
    const form = await openEdit(user);
    const number = form.getByLabelText(claims.claimNumberLabel);
    await user.clear(number);
    await user.type(number, 'CL-8');
    await user.click(form.getByRole('button', { name: claims.save }));

    expect(await form.findByText(message)).toBeInTheDocument();
    expect(number).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText(claims.saved)).not.toBeInTheDocument();
  });

  it('sends the deductible in cents', async () => {
    const { user } = open({ claim: CLAIM, intake: null }, putSaved);
    const form = await openEdit(user);
    const deductible = form.getByLabelText(claims.deductibleLabel);
    await user.clear(deductible);
    await user.type(deductible, '1,250.50');
    await user.click(form.getByRole('button', { name: claims.save }));

    expect(await screen.findByText(claims.saved)).toBeInTheDocument();
    expect(api.sent('PUT /api/jobs/j1/claim')).toEqual([{ deductibleCents: 125050 }]);
  });
});

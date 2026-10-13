import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentsOverview, ClaimBoardRow } from '@roofline/shared';
import { AgentsWindow } from '../src/features/agents/AgentsWindow.tsx';
import { ClaimsBoard } from '../src/features/agents/ClaimsBoard.tsx';
import { ACCOUNT, renderAt, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});
const overview: AgentsOverview = {
  minutesThisMonth: 120,
  hourlyRateCents: null,
  cards: [
    { agent: 'storm_scout', status: 'on', finishedToday: 3, minutesThisMonth: 90, successRate: 0.8, notApproved30d: 2, waitingCount: 1, last14Days: [] },
    { agent: 'claims', status: 'paused', finishedToday: 1, minutesThisMonth: 30, successRate: null, notApproved30d: 0, waitingCount: 0, last14Days: [] },
  ],
};
const rows: ClaimBoardRow[] = [
  { claimId: 'a', jobId: 'j1', customerName: 'Pat Doe', address: '1 Main St', insurer: 'Prairie Mutual', claimNumber: 'CL-7', status: 'filed', statusChangedAt: '2026-10-12T15:00:00Z' },
  { claimId: 'b', jobId: 'j2', customerName: 'Lee Kim', address: null, insurer: null, claimNumber: null, status: 'denied', statusChangedAt: '2026-10-13T15:00:00Z' },
];

describe('Ironclad task 07', () => {
  it('lets a rep inspect a real agent snapshot without changing it or exposing money/settings', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'rep' } }),
      'GET /api/agents': () => ({ body: overview }),
    });
    renderAt(<AgentsWindow />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Inspect Claims' }));
    const summary = screen.getByRole('region', { name: 'Agent summary' });
    expect(within(summary).getByRole('link', { name: 'Open Claims' })).toHaveAttribute('href', '/agents/claims');
    expect(within(summary).getByText('Paused')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review waiting work' })).toHaveAttribute('href', '/agents/waiting');
    expect(document.body.textContent).not.toContain('$');
    expect(screen.queryByRole('link', { name: 'Agent settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('filters claims by status and text, then clears both without losing job links', async () => {
    api = stubApi({
      'GET /api/company': () => ({ body: { timezone: 'America/Chicago' } }),
      'GET /api/claims': () => ({ body: { claims: rows } }),
    });
    renderAt(<ClaimsBoard />);
    const user = userEvent.setup();
    await screen.findByRole('link', { name: /Pat Doe/ });
    await user.click(screen.getByRole('button', { name: 'Filed 1' }));
    expect(screen.queryByRole('link', { name: /Lee Kim/ })).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Search claims' }), 'missing');
    expect(screen.getByText('No claims match these filters.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('link', { name: /Pat Doe/ })).toHaveAttribute('href', '/jobs/j1');
    expect(screen.getByRole('link', { name: /Lee Kim/ })).toHaveAttribute('href', '/jobs/j2');
  });

  it('edits an inline claim through the existing mutation and refreshes its board row', async () => {
    let number = 'CL-7';
    let body: unknown;
    const claim = () => ({
      id: 'a', jobId: 'j1', insurer: 'Prairie Mutual', claimNumber: number, status: 'filed', dateOfLoss: null,
      adjusterName: null, adjusterPhone: null, adjusterEmail: null, deductibleCents: null, notes: null, events: [],
    });
    api = stubApi({
      'GET /api/company': () => ({ body: { timezone: 'America/Chicago' } }),
      'GET /api/claims': () => ({ body: { claims: [{ ...rows[0], claimNumber: number }, rows[1]] } }),
      'GET /api/jobs/j1/claim': () => ({ body: { intake: null, packet: null, claim: claim() } }),
      'PUT /api/jobs/j1/claim': (request) => {
        body = request.body;
        number = 'CL-8';
        return { body: claim() };
      },
    });
    renderAt(<ClaimsBoard />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'View claim for Pat Doe' }));
    const panel = screen.getByRole('complementary', { name: 'Selected claim' });
    expect(panel).toHaveFocus();
    expect(within(panel).getByRole('link', { name: 'Open job' })).toHaveAttribute('href', '/jobs/j1');
    expect(await within(panel).findByRole('button', { name: 'Build claim packet' })).toBeInTheDocument();
    expect(within(panel).queryByRole('link', { name: /Download packet/ })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Edit' }));
    const form = within(screen.getByRole('dialog', { name: 'Insurance claim' }));
    await user.clear(form.getByLabelText('Claim number'));
    await user.type(form.getByLabelText('Claim number'), 'CL-8');
    await user.click(form.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('link', { name: /Pat Doe.*Claim CL-8/ })).toHaveAttribute('href', '/jobs/j1');
    expect(body).toEqual({ claimNumber: 'CL-8' });
  });

  it('recovers a claims load failure with the existing query', async () => {
    let fail = true;
    api = stubApi({
      'GET /api/company': () => ({ body: { timezone: 'America/Chicago' } }),
      'GET /api/claims': () => fail ? { status: 500, body: { error: 'Unavailable' } } : { body: { claims: rows } },
    });
    renderAt(<ClaimsBoard />);
    const user = userEvent.setup();
    await screen.findByText('We could not load the claims.');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /Pat Doe/ })).toHaveAttribute('href', '/jobs/j1');
  });
});

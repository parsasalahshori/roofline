import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StormWindow } from '../src/features/storm/StormWindow.tsx';
import { doors } from '../src/copy/doors.ts';
import { storm } from '../src/copy/storm.ts';
import { ACCOUNT, makeTask, renderAt, stubApi, SHELL_ROUTES, where } from './helpers.tsx';

/** The storm plan card for one draft: the approvals list holds just that task. */
function stubPlan(summary: string | null) {
  return stubApi({
    ...SHELL_ROUTES,
    'GET /api/approvals': () => ({
      body: { count: 1, tasks: [makeTask({ id: 't1', title: 'Storm plan for Maple Ridge', summary })] },
    }),
  });
}

describe('StormWindow', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
  ])('a storm plan with a summary of %s shows its title and approve link and no empty paragraph', async (_label, summary) => {
    const api = stubPlan(summary);
    renderAt(<StormWindow />);

    expect(await screen.findByText('Storm plan for Maple Ridge')).toBeInTheDocument();
    const approve = screen.getByRole('link', { name: storm.approve });
    expect(approve).toHaveAttribute('href', '/storm/plans/t1');
    const card = screen.getByRole('region', { name: storm.planHeading });
    expect(card.querySelectorAll('p')).toHaveLength(0);
    expect(api.unexpected).toEqual([]);
  });

  it('a storm plan with a summary shows it', async () => {
    const api = stubPlan('Hail hit 120 homes.');
    renderAt(<StormWindow />);

    expect(await screen.findByText('Hail hit 120 homes.')).toBeInTheDocument();
    const card = screen.getByRole('region', { name: storm.planHeading });
    expect(card.querySelectorAll('p')).toHaveLength(1);
    expect(api.unexpected).toEqual([]);
  });

  it.each(['owner', 'rep'] as const)('links to My routes for a %s', async (role) => {
    const api = stubApi({ ...SHELL_ROUTES, 'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role } }) });
    renderAt(<StormWindow />);

    const link = screen.getByRole('link', { name: doors.myRoutesLink });
    expect(link).toHaveAttribute('href', '/storm/routes');
    await waitFor(() => expect(api.count('GET /api/storms')).toBeGreaterThan(0));
  });

  it('My routes navigates to the routes page', async () => {
    stubApi({ ...SHELL_ROUTES });
    const { router, user } = renderAt(<StormWindow />, '/storm');
    await user.click(screen.getByRole('link', { name: doors.myRoutesLink }));
    expect(where(router)).toBe('/storm/routes');
  });

  it('shows a loading status while the storms load', () => {
    stubApi({ ...SHELL_ROUTES });
    const answer = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === '/api/storms' ? new Promise<Response>(() => undefined) : answer(input, init),
      ),
    );
    renderAt(<StormWindow />);
    expect(screen.getByRole('status', { name: storm.loading })).toBeInTheDocument();
  });
});

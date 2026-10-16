import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StormWindow } from '../src/features/storm/StormWindow.tsx';
import { doors } from '../src/copy/doors.ts';
import { storm } from '../src/copy/storm.ts';
import { ACCOUNT, makeTask, renderAt, stubApi, SHELL_ROUTES, where } from './helpers.tsx';

/** The approvals list holds these tasks and nothing else. */
function stubPlans(tasks: ReturnType<typeof makeTask>[], role: 'owner' | 'office' | 'rep' = 'owner') {
  return stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role } }),
    'GET /api/approvals': () => ({ body: { count: tasks.length, tasks } }),
  });
}

describe('StormWindow', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('offers the newest storm plan as a card with its title, the facts and the approve link', async () => {
    const api = stubPlans([
      makeTask({ id: 't1', title: 'Storm plan for Maple Ridge', createdAt: '2026-10-12T09:00:00.000Z' }),
      makeTask({ id: 't2', title: 'Storm plan for Oak Park', createdAt: '2026-10-13T09:00:00.000Z' }),
    ]);
    renderAt(<StormWindow />);

    const card = await screen.findByRole('article', { name: 'Storm plan for Oak Park' });
    const region = screen.getByRole('region', { name: storm.planHeading });
    expect(region).toContainElement(card);
    // The newest is the one on offer; the older one is a line under it
    expect(screen.queryByRole('article', { name: 'Storm plan for Maple Ridge' })).toBeNull();
    expect(within(card).getByRole('link', { name: storm.approve })).toHaveAttribute('href', '/storm/plans/t2');
    expect(within(region).getByText('1 more plan needs your OK')).toBeInTheDocument();
    expect(api.unexpected).toEqual([]);
  });

  it('only counts plans from Storm Scout', async () => {
    stubPlans([makeTask({ id: 't1', agent: 'scheduler', title: 'Rain on the install day' })]);
    renderAt(<StormWindow />);

    expect(await screen.findByText(storm.noPlanWaiting)).toBeInTheDocument();
    expect(screen.getByText(storm.noPlanWaitingHelp)).toBeInTheDocument();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('shows no plan to a rep: plans are for the owner and office', async () => {
    const api = stubPlans([makeTask({ id: 't1', title: 'Storm plan for Maple Ridge' })], 'rep');
    renderAt(<StormWindow />);

    expect(await screen.findByText(storm.noPlanWaiting)).toBeInTheDocument();
    expect(screen.queryByRole('article')).toBeNull();
    await waitFor(() => expect(api.count('GET /api/storms')).toBeGreaterThan(0));
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

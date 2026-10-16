import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keys } from '../src/api/keys.ts';
import { search } from '../src/copy/search.ts';
import { shell } from '../src/copy/shell.ts';
import { AgentsWorking } from '../src/shell/topbar/AgentsWorking.tsx';
import { PhoneChrome } from '../src/shell/phone/PhoneChrome.tsx';
import { ShellTopBar } from '../src/shell/topbar/ShellTopBar.tsx';
import { ACCOUNT, makeTask, renderAt, SHELL_ROUTES, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

describe('agents working', () => {
  it.each([0, 1, 3])('says how many agents are working (%i)', async (working) => {
    api = stubApi({ ...SHELL_ROUTES, 'GET /api/tasks/summary': () => ({ body: { working } }) });
    renderAt(<AgentsWorking />);
    const text = await screen.findByText(shell.agentsWorking(working));
    expect(text).toHaveAttribute('data-state', working > 0 ? 'working' : 'quiet');
  });

  it('is a link to the activity feed', async () => {
    api = stubApi({ ...SHELL_ROUTES, 'GET /api/tasks/summary': () => ({ body: { working: 2 } }) });
    renderAt(<AgentsWorking />);
    const text = await screen.findByText(shell.agentsWorking(2));
    expect(text).toHaveAttribute('data-state', 'working');
    expect(screen.getByRole('link', { name: shell.agentsWorking(2) })).toHaveAttribute('href', '/agents/feed');
  });

  it('shows nothing when the count cannot be loaded', async () => {
    api = stubApi({
      ...SHELL_ROUTES,
      'GET /api/tasks/summary': () => ({ status: 500, body: { error: 'Tasks are down.' } }),
    });
    const { queryClient } = renderAt(<AgentsWorking />);
    await waitFor(() => expect(queryClient.getQueryState(keys.summary)?.status).toBe('error'));
    expect(screen.queryByText(shell.agentsWorking(0))).toBeNull();
    expect(document.querySelector('[data-state]')).toBeNull();
  });
});

function bar() {
  return <ShellTopBar crumbsRef={() => {}} actionsRef={() => {}} />;
}

describe('top bar', () => {
  it('is the slim bar of a page: the trail slot, then the pill, the agents, the bell and the clock', async () => {
    api = stubApi({
      ...SHELL_ROUTES,
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/approvals': () => ({ body: { count: 1, tasks: [makeTask({ id: 't1' })] } }),
      'GET /api/tasks/summary': () => ({ body: { working: 2 } }),
    });
    renderAt(bar());
    const banner = screen.getByRole('banner');
    expect(await screen.findByRole('link', { name: shell.needYourOk(1) })).toHaveAttribute('href', '/approvals/t1');
    expect(await screen.findByText(shell.agentsWorking(2))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: shell.notificationsLabel })).toHaveAttribute('href', '/approvals');
    expect(banner.querySelector('time')).not.toBeNull();
    // The company, the search and the person are in the rail on a desktop, not here
    expect(screen.queryByText(ACCOUNT.company.name)).toBeNull();
    expect(screen.queryByRole('button', { name: ACCOUNT.user.name })).toBeNull();
  });

  it('has no phone version: a phone draws no bar and its pages carry the controls', async () => {
    api = stubApi({
      ...SHELL_ROUTES,
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/approvals': () => ({ body: { count: 2, tasks: [makeTask({ id: 't1' }), makeTask({ id: 't2' })] } }),
    });
    renderAt(<PhoneChrome />);
    expect(screen.getByRole('button', { name: search.open })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: shell.notificationsLabel })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: ACCOUNT.user.name })).toBeInTheDocument();
    // Not the pill, the agents or the clock: the Today tab and the More sheet count what waits
    expect(screen.queryByRole('link', { name: shell.needYourOk(2) })).toBeNull();
    expect(screen.queryByText(shell.agentsWorking(0))).toBeNull();
  });
});

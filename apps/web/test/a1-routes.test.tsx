import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { agents } from '../src/copy/agents.ts';
import { WINDOW_COPY } from '../src/copy/dock.ts';
import { AGENT_LABEL } from '../src/copy/status.ts';
import { agentFromSlug, agentSlug, PAGE_AGENTS } from '../src/features/agents/slugs.ts';
import { ACCOUNT, type Routes, SHELL_ROUTES, stubApi } from './helpers.tsx';

// The real map loads maplibre-gl, which these tests never need. The stand-in has two pins that open a job and a customer.
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return {
    MapView: (props: { onOpen: (target: { kind: 'customer' | 'job'; id: string }) => void }) =>
      createElement(
        'div',
        { 'data-map-mock': true },
        createElement('button', { type: 'button', onClick: () => props.onOpen({ kind: 'job', id: 'j9' }) }, 'job pin'),
        createElement('button', { type: 'button', onClick: () => props.onOpen({ kind: 'customer', id: 'c9' }) }, 'customer pin'),
      ),
  };
});

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A signed-in person whose shell reads answer "nothing", unless a test gives its own answers. */
function signedInApi(account = ACCOUNT, overrides: Routes = {}) {
  api = stubApi({ ...SHELL_ROUTES, 'GET /api/auth/me': () => ({ body: account }), ...overrides });
  return api;
}

const AGENTS_EMPTY: Routes = {
  'GET /api/agents/feed': () => ({ body: { items: [], nextCursor: null } }),
  'GET /api/agents/waiting': () => ({ body: { items: [] } }),
};

function renderApp(path: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: [path] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, queryClient, user: userEvent.setup() };
}


describe('A1 windows', () => {
  it.each([
    ['/agents', agents.overviewComingSoon],
  ])('%s shows its placeholder in the Agents window', async (path, line) => {
    signedInApi();
    renderApp(path);

    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    expect(await within(dialog).findByText(line)).toBeInTheDocument();
  });

  it.each([
    ['/agents/feed', agents.feedEmpty],
    ['/agents/waiting', agents.waitingEmpty],
  ])('%s shows its list in the Agents window', async (path, line) => {
    signedInApi(ACCOUNT, AGENTS_EMPTY);
    renderApp(path);

    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    expect(await within(dialog).findByText(line)).toBeInTheDocument();
  });

  it.each(PAGE_AGENTS)('shows the %s page with its name', async (agent) => {
    signedInApi();
    renderApp('/agents/' + agentSlug(agent));

    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    expect(await within(dialog).findByText(AGENT_LABEL[agent])).toBeInTheDocument();
    expect(within(dialog).getByText(agents.agentComingSoon)).toBeInTheDocument();
  });

  it('lets feed win over :agent', async () => {
    signedInApi(ACCOUNT, AGENTS_EMPTY);
    renderApp('/agents/feed');

    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    expect(await within(dialog).findByText(agents.feedEmpty)).toBeInTheDocument();
    expect(within(dialog).queryByText(agents.agentComingSoon)).not.toBeInTheDocument();
  });

  it.each(['/agents/nobody', '/agents/system'])('%s shows the not-found window', async (path) => {
    signedInApi();
    renderApp(path);

    expect(await screen.findByRole('dialog', { name: WINDOW_COPY.notFound.title })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: WINDOW_COPY.agents.title })).not.toBeInTheDocument();
  });

  it('marks the current tab and links the others', async () => {
    signedInApi(ACCOUNT, AGENTS_EMPTY);
    renderApp('/agents/feed');

    const dialog = await screen.findByRole('dialog', { name: WINDOW_COPY.agents.title });
    const tabs = within(dialog).getByRole('navigation', { name: agents.tabsLabel });
    expect(within(tabs).getByRole('link', { name: agents.tabs.feed })).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).getByRole('link', { name: agents.tabs.waiting })).toHaveAttribute('href', '/agents/waiting');
    expect(await within(dialog).findByText(agents.feedEmpty)).toBeInTheDocument();
  });
});

describe('agent slugs', () => {
  it.each(PAGE_AGENTS)('round-trips %s', (agent) => {
    expect(agentFromSlug(agentSlug(agent))).toBe(agent);
  });

  it('knows no page for system or unknown slugs', () => {
    expect(agentFromSlug('system')).toBeUndefined();
    expect(agentFromSlug('x')).toBeUndefined();
    expect(agentFromSlug(undefined)).toBeUndefined();
    expect(agentSlug('front_desk')).toBe('front-desk');
  });
});

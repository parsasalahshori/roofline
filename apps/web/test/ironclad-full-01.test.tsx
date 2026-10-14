import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { createAppRouter } from '../src/app/router.tsx';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { dock } from '../src/copy/dock.ts';
import { search } from '../src/copy/search.ts';
import { ACCOUNT, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

vi.mock('../src/shell/map/MapView.tsx', () => ({ MapView: () => null }));
let api: ReturnType<typeof stubApi>;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api.unexpected).toEqual([]);
});

function start(path = '/') {
  api = stubApi({ ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/jobs/board': () => ({ body: { columns: [], lost: { count: 0 } } }),
    'GET /api/team': () => ({ body: { members: [] } }),
  });
  const router = createAppRouter({ initialEntries: [path] });
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  render(<Providers client={client}><RouterProvider router={router} /></Providers>);
  return { router, user: userEvent.setup() };
}

it('updates the window inset when a billing banner changes height and releases the observer', async () => {
  let resize = () => {};
  let slot: Element | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe(element: Element) { slot = element; }
    disconnect = disconnect;
  });
  start('/jobs');
  await screen.findByRole('dialog', { name: 'Jobs' });
  expect(slot).toBeDefined();
  vi.spyOn(slot!, 'getBoundingClientRect').mockReturnValue({ height: 68.4 } as DOMRect);
  act(() => resize());
  expect((slot!.parentElement as HTMLElement).style.getPropertyValue('--shell-banner-height')).toBe('68px');
  vi.spyOn(slot!, 'getBoundingClientRect').mockReturnValue({ height: 0 } as DOMRect);
  act(() => resize());
  expect((slot!.parentElement as HTMLElement).style.getPropertyValue('--shell-banner-height')).toBe('0px');
  cleanup();
  expect(disconnect).toHaveBeenCalledOnce();
});

it('search Escape leaves the app open; window Escape returns to its dock opener', async () => {
  const { router, user } = start();
  const nav = await screen.findByRole('navigation', { name: dock.label });
  const jobs = within(nav).getByRole('link', { name: 'Jobs' });
  await user.click(jobs);
  const window = await screen.findByRole('dialog', { name: 'Jobs' });
  await user.click(screen.getByRole('button', { name: search.open }));
  await screen.findByRole('combobox', { name: search.inputLabel });
  await user.keyboard('{Escape}');
  expect(where(router)).toBe('/jobs');
  expect(window).toBeInTheDocument();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(where(router)).toBe('/'));
  expect(jobs).toHaveFocus();
});

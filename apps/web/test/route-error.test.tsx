import { cleanup, render, screen } from '@testing-library/react';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { rail } from '../src/copy/rail.ts';
import { errors } from '../src/copy/errors.ts';
import { ACCOUNT, SHELL_ROUTES, stubApi } from './helpers.tsx';

/*
 * A window that fails to render shows the error page in the window area. The shell around it (the
 * dock and the top bar) stays, so the person can go elsewhere without reloading.
 */

vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

vi.mock('../src/features/today/Today.tsx', () => ({
  Today: () => {
    throw new Error('The Today window broke');
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('a window that crashes shows the error in the window area and keeps the dock', async () => {
  // React logs the caught error; keep the test output quiet
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const api = stubApi({ ...SHELL_ROUTES, 'GET /api/auth/me': () => ({ body: ACCOUNT }) });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={createAppRouter({ initialEntries: ['/today'] })} />
    </Providers>,
  );

  // Found by its text: the toast region is another, always-mounted alert
  const title = await screen.findByText(errors.pageTitle);
  expect(title.closest('[role="alert"]')).toHaveAttribute('data-variant', 'window');
  expect(screen.getByRole('navigation', { name: rail.label })).toBeInTheDocument();
  expect(api.unexpected).toEqual([]);
});

import { cleanup, render, waitFor } from '@testing-library/react';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { ACCOUNT, SHELL_ROUTES, stubApi } from './helpers.tsx';

// Counts how many times the map module is loaded. A static import loads it with the app; the shell loads it on first render.
const mapLoads = vi.hoisted(() => ({ count: 0 }));

vi.mock('../src/shell/map/MapView.tsx', async () => {
  mapLoads.count += 1;
  const { createElement } = await import('react');
  return {
    MapView: () => createElement('div', { 'data-map-mock': true }),
  };
});

let api: ReturnType<typeof stubApi> | undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
  api = undefined;
});

it('loads the map module only when the shell renders it, and then shows it', async () => {
  // The map is not part of the app's first load: nothing has loaded it yet
  expect(mapLoads.count).toBe(0);

  api = stubApi({ ...SHELL_ROUTES, 'GET /api/auth/me': () => ({ body: ACCOUNT }) });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: ['/'] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );

  await waitFor(() => expect(document.querySelector('[data-map-mock]')).not.toBeNull());
  expect(mapLoads.count).toBe(1);
});

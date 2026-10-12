import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { Button } from '@roofline/ui';
import { afterEach, expect, it } from 'vitest';
import { Providers } from '../src/app/providers.tsx';

afterEach(cleanup);

// Button's props type has no download attribute; pass it through a spread, as ProgressStep.tsx does, so it still reaches the anchor.
const downloadAttributes = { download: true };

function Page() {
  const location = useLocation();
  return (
    <div>
      <Button href="/api/imports/x/skipped.csv" {...downloadAttributes}>
        get file
      </Button>
      <Button href="/somewhere">go there</Button>
      <output data-testid="path">{location.pathname}</output>
    </div>
  );
}

function mount() {
  const router = createMemoryRouter([
    { path: '/', element: <Page /> },
    { path: '/somewhere', element: <Page /> },
  ]);
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}

/** Records defaultPrevented as the click bubbles to the window, then stops jsdom from logging a navigation. */
function watchWindow() {
  const seen: boolean[] = [];
  const listener = (e: Event) => {
    seen.push(e.defaultPrevented);
    e.preventDefault();
  };
  window.addEventListener('click', listener);
  return { seen, stop: () => window.removeEventListener('click', listener) };
}

it('download link click is not default-prevented and does not navigate', () => {
  const router = mount();
  const watch = watchWindow();
  const anchor = screen.getByRole('link', { name: 'get file' });
  const event = createEvent.click(anchor);
  fireEvent(anchor, event);
  watch.stop();
  expect(watch.seen).toEqual([false]);
  expect(router.state.location.pathname).toBe('/');
  expect(anchor.getAttribute('href')).toBe('/api/imports/x/skipped.csv');
  expect(anchor.hasAttribute('download')).toBe(true);
});

it('plain link without download is default-prevented', () => {
  const router = mount();
  const anchor = screen.getByRole('link', { name: 'go there' });
  const event = createEvent.click(anchor);
  fireEvent(anchor, event);
  expect(event.defaultPrevented).toBe(true);
  expect(router.state.location.pathname).toBe('/somewhere');
});

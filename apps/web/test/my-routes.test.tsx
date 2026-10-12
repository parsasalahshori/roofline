import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MyRoutes } from '../src/features/storm/routes/MyRoutes.tsx';
import styles from '../src/features/storm/routes/MyRoutes.module.css';
import { doors } from '../src/copy/doors.ts';
import { renderAt, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const ROUTE_1 = {
  id: 'r1',
  companyStormId: 'cs1',
  stormId: 'st1',
  userId: 'u1',
  name: 'Omaha · Route 1 (Sam)',
  status: 'in_progress' as const,
  stops: 12,
  doneStops: 3,
};
const ROUTE_2 = {
  id: 'r2',
  companyStormId: 'cs1',
  stormId: 'st1',
  userId: 'u1',
  name: 'Omaha · Route 2 (Sam)',
  status: 'ready' as const,
  stops: 8,
  doneStops: 0,
};

describe('my routes', () => {
  it('lists the rep routes with progress', async () => {
    api = stubApi({ 'GET /api/routes/mine': () => ({ body: { routes: [ROUTE_1, ROUTE_2] } }) });
    renderAt(<MyRoutes />, '/storm/routes');

    const first = await screen.findByRole('link', { name: doors.routeLinkLabel(ROUTE_1.name, 3, 12) });
    expect(first).toHaveAttribute('href', '/storm/routes/r1');
    expect(within(first).getByText(doors.progress(3, 12))).toBeInTheDocument();
    expect(within(first).getByText(doors.routeStatus.in_progress)).toBeInTheDocument();
    expect(within(first).getByText(ROUTE_1.name)).toBeInTheDocument();

    const second = screen.getByRole('link', { name: doors.routeLinkLabel(ROUTE_2.name, 0, 8) });
    expect(second).toHaveAttribute('href', '/storm/routes/r2');
    expect(within(second).getByText(doors.routeStatus.ready)).toBeInTheDocument();
    expect(within(second).getByText(doors.progress(0, 8))).toBeInTheDocument();
  });

  it('renders the progress text from an API-shaped fixture', async () => {
    api = stubApi({
      'GET /api/routes/mine': () => ({
        body: {
          routes: [
            {
              id: 'r9',
              companyStormId: 'cs1',
              stormId: 'st1',
              userId: 'u1',
              name: 'Omaha · Route 9 (Sam)',
              status: 'in_progress',
              stops: 12,
              doneStops: 3,
            },
          ],
        },
      }),
    });
    renderAt(<MyRoutes />, '/storm/routes');

    const link = await screen.findByRole('link', { name: doors.routeLinkLabel('Omaha · Route 9 (Sam)', 3, 12) });
    expect(within(link).getByText('3 of 12 doors')).toBeInTheDocument();
  });

  it('shows the empty line when there are no routes', async () => {
    api = stubApi({ 'GET /api/routes/mine': () => ({ body: { routes: [] } }) });
    renderAt(<MyRoutes />, '/storm/routes');

    expect(await screen.findByText(doors.myRoutesEmpty)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows the error line when the read fails', async () => {
    api = stubApi({ 'GET /api/routes/mine': () => ({ status: 500, body: { error: 'boom' } }) });
    renderAt(<MyRoutes />, '/storm/routes');

    expect(await screen.findByText(doors.myRoutesError)).toBeInTheDocument();
  });

  it('layout classes keep 375px safe', () => {
    // Read from disk: a CSS module import would give class names, not the source
    const css = readFileSync(join(import.meta.dirname, '../src/features/storm/routes/MyRoutes.module.css'), 'utf8');
    expect(css).toContain('min-width: 0');
    for (const match of css.matchAll(/width:\s*(\d+)px/g)) {
      expect(Number(match[1])).toBeLessThanOrEqual(375);
    }
    expect(styles.list).toBeTruthy();
  });

  it('marks the list with its layout class', async () => {
    api = stubApi({ 'GET /api/routes/mine': () => ({ body: { routes: [ROUTE_1] } }) });
    renderAt(<MyRoutes />, '/storm/routes');

    await screen.findByRole('link', { name: doors.routeLinkLabel(ROUTE_1.name, 3, 12) });
    expect(screen.getByRole('list')).toHaveClass(styles.list);
  });
});

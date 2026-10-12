import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompanyBody } from '../src/api/types.ts';
import { createAppRouter } from '../src/app/router.tsx';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { today } from '../src/copy/today.ts';
import { ACCOUNT, makeTask, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

// The real map loads maplibre-gl, which these tests never need
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

// These tests wait on several renders; on a busy machine the defaults are too tight
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

const DANA = { ...ACCOUNT, user: { ...ACCOUNT.user, name: 'Dana Ruiz' } };

const COMPANY_BODY: CompanyBody = {
  id: 'c1',
  name: 'Summit Roofing',
  slug: 'summit-roofing',
  status: 'active',
  legalName: null,
  phone: null,
  email: null,
  website: null,
  addressStreet: null,
  addressCity: null,
  addressState: null,
  addressZip: null,
  timezone: 'America/Chicago',
  logoUrl: null,
  located: false,
  serviceAreaMiles: null,
};

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Renders the app at `initialEntries` with the shell's reads stubbed, plus `own` routes. */
function mount(initialEntries: string[], own: Parameters<typeof stubApi>[0] = {}, { strict = false } = {}) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: DANA }),
    'GET /api/company': () => ({ body: COMPANY_BODY }),
    ...own,
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries });
  const tree = (
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { router, user: userEvent.setup() };
}

/** Lets a fire-and-forget request finish its answer and any follow-up navigation. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('the Today window', () => {
  it('greets by first name in the company time zone', async () => {
    // Only Date is faked, so timers and promises still run
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T14:00:00Z')); // 09:00 in Chicago

    mount(['/today']);

    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: 'Good morning, Dana',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Monday, October 12')).toBeInTheDocument();
    expect(api.unexpected).toEqual([]);
  });

  it('lists the top 3 drafts', async () => {
    const tasks = [1, 2, 3, 4, 5].map((n) =>
      makeTask({
        id: `t${n}`,
        title: `Plan ${n}`,
        status: 'draft',
        createdAt: `2026-10-0${n}T09:00:00.000Z`,
      }),
    );
    mount(['/today'], {
      'GET /api/approvals': () => ({ body: { count: 5, tasks } }),
    });

    const dialog = await screen.findByRole('dialog');
    const section = await within(dialog).findByRole('region', {
      name: today.needYourOk,
    });
    const list = await within(section).findByRole('list', {
      name: today.draftsLabel,
    });
    const links = within(list).getAllByRole('link');

    // Newest first: Plan 5, Plan 4, Plan 3
    expect(links).toHaveLength(3);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/approvals/t5', '/approvals/t4', '/approvals/t3']);
    expect(links[0]).toHaveTextContent('Plan 5');
    expect(links[2]).toHaveTextContent('Plan 3');

    const seeAll = within(section).getByRole('link', { name: today.seeAll(5) });
    expect(seeAll).toHaveAttribute('href', '/approvals');
    expect(api.unexpected).toEqual([]);
  });

  it('says when nothing needs an OK', async () => {
    mount(['/today']);

    expect(await screen.findByText(today.nothingNeedsYou)).toBeInTheDocument();
    expect(api.unexpected).toEqual([]);
  });
});

describe('auto-opens only from the map home', () => {
  it('opens Today once when the server says to show it', async () => {
    const { router } = mount(['/'], {
      'POST /api/me/today-shown': () => ({ body: { show: true } }),
    });

    await waitFor(() => expect(where(router)).toBe('/today'));
    expect(api.count('POST /api/me/today-shown')).toBe(1);
    expect(api.unexpected).toEqual([]);
  });

  it('asks once even when the page renders twice', async () => {
    const { router } = mount(['/'], { 'POST /api/me/today-shown': () => ({ body: { show: true } }) }, { strict: true });

    await waitFor(() => expect(where(router)).toBe('/today'));
    await settle();
    expect(api.count('POST /api/me/today-shown')).toBe(1);
    expect(api.unexpected).toEqual([]);
  });

  it('stays on the map when the server says not to show it', async () => {
    const { router } = mount(['/'], {
      'POST /api/me/today-shown': () => ({ body: { show: false } }),
    });

    await waitFor(() => expect(api.count('POST /api/me/today-shown')).toBe(1));
    await settle();
    expect(where(router)).toBe('/');
    expect(api.unexpected).toEqual([]);
  });

  it('never asks from a deep link', async () => {
    const { router } = mount(['/jobs'], {
      'POST /api/me/today-shown': () => ({ body: { show: true } }),
    });

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await settle();
    expect(api.count('POST /api/me/today-shown')).toBe(0);
    expect(where(router)).toBe('/jobs');
    expect(api.unexpected).toEqual([]);
  });

  it('does not hijack a page the person opened before the answer arrives', async () => {
    const { router } = mount(['/'], {
      'POST /api/me/today-shown': () => ({ body: { show: true } }),
    });
    // The stub answers at once, so gate its fetch until the person has moved on
    const answer = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let asked = false;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/me/today-shown')) {
        asked = true;
        return gate.then(() => answer(input, init));
      }
      return answer(input, init);
    };

    await waitFor(() => expect(asked).toBe(true));
    // The person opens a dock app before the answer comes back
    await router.navigate('/jobs');
    await settle(); // the page renders on /jobs before the answer lands
    release();
    await settle();

    expect(api.count('POST /api/me/today-shown')).toBe(1);
    expect(where(router)).toBe('/jobs');
    expect(api.unexpected).toEqual([]);
  });
});

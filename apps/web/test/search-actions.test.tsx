import { cleanup, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '../src/api/types.ts';
import { search } from '../src/copy/search.ts';
import { SearchDialog } from '../src/shell/topbar/SearchDialog.tsx';
import { measureOptions } from '../src/shell/topbar/searchOptions.ts';
import { ACCOUNT, renderAt, stubApi, where } from './helpers.tsx';

const EMPTY = { customers: [], jobs: [], addresses: [] };

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  expect(api?.unexpected ?? []).toEqual([]);
});

function setup(role: Account['role'] = 'owner') {
  api = stubApi({
    'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role } }),
    // Typing a word of two letters or more also asks the server; the answer is nothing
    'GET /api/search?q=new': () => ({ body: EMPTY }),
    'GET /api/search?q=book': () => ({ body: EMPTY }),
    'GET /api/search?q=down': () => ({ body: EMPTY }),
  });
  return renderAt(<SearchDialog />);
}

/** Opens with Ctrl+K, then waits until the signed-in account has loaded. */
async function open(user: UserEvent) {
  await user.keyboard('{Control>}k{/Control}');
  const combobox = await screen.findByRole('combobox', { name: search.inputLabel });
  await waitFor(() => expect(api.count('GET /api/auth/me')).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return combobox;
}

const { newJob, newCustomer, bookInspection, downloadCustomers } = search.actionItems;

describe('search actions', () => {
  it('lists matching actions under Actions', async () => {
    const { user } = setup();
    const combobox = await open(user);
    await user.type(combobox, 'new');

    const group = await screen.findByRole('group', { name: search.actions });
    expect(within(group).getByRole('option', { name: newJob.label })).toBeInTheDocument();
    expect(within(group).getByRole('option', { name: newCustomer.label })).toBeInTheDocument();
  });

  it('opens New job and Book an inspection with the keyboard', async () => {
    const first = setup();
    const combobox = await open(first.user);
    await first.user.type(combobox, 'new');
    await screen.findByRole('option', { name: newJob.label });
    await first.user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(where(first.router)).toBe('/jobs/new'));
    cleanup();

    const second = setup();
    const input = await open(second.user);
    await second.user.type(input, 'book');
    await screen.findByRole('option', { name: bookInspection.label });
    await second.user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(where(second.router)).toBe('/calendar/new?kind=inspection'));
  });

  it.each(['owner', 'office'] as const)('offers the customers download to %s', async (role) => {
    const { user } = setup(role);
    const combobox = await open(user);
    await user.type(combobox, 'down');
    expect(await screen.findByRole('option', { name: downloadCustomers.label })).toBeInTheDocument();
  });

  it('does not offer the customers download to a rep', async () => {
    const { user } = setup('rep');
    const combobox = await open(user);
    await user.type(combobox, 'down');
    expect(await screen.findByText(search.noMatches('down'))).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: downloadCustomers.label })).not.toBeInTheDocument();
  });
});

describe('search recents', () => {
  const key = `roofline.recents.${ACCOUNT.company.id}`;

  it('lists recents on an empty query and opens one', async () => {
    window.localStorage.setItem(
      key,
      JSON.stringify([
        { kind: 'job', id: 'j1', label: 'Maria Lopez roof' },
        { kind: 'customer', id: 'c1', label: 'Ben Carter' },
      ]),
    );
    const { router, user } = setup();
    await open(user);

    const group = await screen.findByRole('group', { name: search.recent });
    expect(within(group).getByRole('option', { name: 'Maria Lopez roof' })).toBeInTheDocument();
    expect(within(group).getByRole('option', { name: 'Ben Carter' })).toBeInTheDocument();

    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(where(router)).toBe('/jobs/j1'));
  });

  it('survives a storage error', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { user } = setup();
    await open(user);

    expect(await screen.findByText(search.hint)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: search.recent })).not.toBeInTheDocument();
  });
});

describe('Measure roof from the search', () => {
  it('offers "Measure roof at", then "Measure windows at", for a typed street address', () => {
    expect(measureOptions('3518  Lowell St NW, Washington, DC')).toEqual([
      {
        key: 'action:measureRoof',
        href: '/estimator?measure=3518%20Lowell%20St%20NW%2C%20Washington%2C%20DC',
        group: 'actions',
        primary: search.measureRoof('3518 Lowell St NW, Washington, DC'),
        secondary: search.measureRoofHint,
      },
      {
        key: 'action:measureWindows',
        href: '/estimator/windows?measure=3518%20Lowell%20St%20NW%2C%20Washington%2C%20DC',
        group: 'actions',
        primary: search.measureWindows('3518 Lowell St NW, Washington, DC'),
        secondary: search.measureWindowsHint,
      },
    ]);
  });

  it('offers nothing for a name, a phone number or a bare number', () => {
    expect(measureOptions('Maria Lopez')).toEqual([]);
    expect(measureOptions('402 555 0100')).toEqual([]);
    expect(measureOptions('12')).toEqual([]);
  });

  it('opens the measure window from the dialog', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/search?q=12 Elm St': () => ({ body: EMPTY }),
      'GET /api/search?q=12%20Elm%20St': () => ({ body: EMPTY }),
    });
    const { user, router } = renderAt(<SearchDialog />);
    const combobox = await open(user);
    await user.type(combobox, '12 Elm St');
    await user.click(await screen.findByRole('option', { name: new RegExp(search.measureRoof('12 Elm St')) }));
    await waitFor(() => expect(where(router)).toBe('/estimator?measure=12%20Elm%20St'));
  });

  it('opens the windows screen from the dialog, right after Measure roof', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/search?q=12 Elm St': () => ({ body: EMPTY }),
      'GET /api/search?q=12%20Elm%20St': () => ({ body: EMPTY }),
    });
    const { user, router } = renderAt(<SearchDialog />);
    const combobox = await open(user);
    await user.type(combobox, '12 Elm St');
    const roof = await screen.findByRole('option', { name: new RegExp(search.measureRoof('12 Elm St')) });
    const windows = screen.getByRole('option', { name: new RegExp(search.measureWindows('12 Elm St')) });
    expect(roof.compareDocumentPosition(windows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(windows);
    await waitFor(() => expect(where(router)).toBe('/estimator/windows?measure=12%20Elm%20St'));
  });
});

describe('address checks', () => {
  it('a whole address has its town, ZIP or state; a bare street is not looked up early', async () => {
    const { looksCompleteAddress, looksLikeAddress } = await import('../src/features/measure/address.ts');
    expect(looksLikeAddress('12 Elm St')).toBe(true);
    expect(looksCompleteAddress('12 Elm St')).toBe(false);
    expect(looksCompleteAddress('12 Elm St, Omaha')).toBe(true);
    expect(looksCompleteAddress('12 Elm St 68102')).toBe(true);
    expect(looksCompleteAddress('3518 Lowell St NW, Washington, DC')).toBe(true);
    expect(looksCompleteAddress('12 Elm St NE')).toBe(true);
    expect(looksCompleteAddress('Maria Lopez, Omaha')).toBe(false);
  });
});

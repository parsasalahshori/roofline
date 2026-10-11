import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { search } from '../src/copy/search.ts';
import { SearchDialog } from '../src/shell/topbar/SearchDialog.tsx';
import { renderAt, stubApi, where } from './helpers.tsx';

const LOP = {
  customers: [{ id: 'c1', displayName: 'Lopez Family', phone: '555-0100' }],
  jobs: [
    {
      id: 'j1',
      stage: 'proposal',
      stageLabel: 'Proposal',
      customerId: 'c1',
      customerName: 'Lopez Family',
      propertyId: 'p1',
      addressLine: '12 Oak St',
    },
  ],
  addresses: [
    {
      id: 'p1',
      addressLine: '12 Oak St',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      customerId: 'c1',
      customerName: 'Lopez Family',
    },
  ],
};

const EMPTY = { customers: [], jobs: [], addresses: [] };

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** The page the dialog lives on: a text field (to press Ctrl+K in) and the search button. */
function renderPage(path = '/') {
  return renderAt(
    <>
      <input aria-label="field" />
      <SearchDialog />
    </>,
    path,
  );
}

/** Opens the dialog from its button. */
async function openFromButton(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: search.open }));
  return screen.findByRole('combobox', { name: search.inputLabel });
}

/** Opens the dialog and types `text`; waits until the three groups are on the screen. */
async function openAndType(user: UserEvent, text: string) {
  const combobox = await openFromButton(user);
  await user.type(combobox, text);
  await screen.findByRole('group', { name: search.customers });
  return combobox;
}

describe('search dialog', () => {
  it('opens on Ctrl+K even from a text field', async () => {
    api = stubApi({});
    const { user } = renderPage();
    const field = screen.getByLabelText('field');
    await user.click(field);

    // preventDefault was called: fireEvent answers false
    expect(fireEvent.keyDown(field, { key: 'k', ctrlKey: true })).toBe(false);
    expect(await screen.findByRole('dialog', { name: search.dialogTitle })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('combobox', { name: search.inputLabel })).toHaveFocus());

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: search.dialogTitle })).not.toBeInTheDocument();
    // Focus goes back to the field Ctrl+K was pressed in
    expect(field).toHaveFocus();

    // Cmd+K on a Mac opens it again
    expect(fireEvent.keyDown(field, { key: 'k', metaKey: true })).toBe(false);
    expect(await screen.findByRole('dialog', { name: search.dialogTitle })).toBeInTheDocument();
  });

  it('opens from the search button', async () => {
    api = stubApi({});
    const { user } = renderPage();

    await user.click(screen.getByRole('button', { name: search.open }));

    expect(await screen.findByRole('dialog', { name: search.dialogTitle })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: search.inputLabel })).toHaveFocus();
  });

  it('closes on Esc and gives focus back to the search button', async () => {
    api = stubApi({});
    const { user } = renderPage();
    await openFromButton(user);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: search.dialogTitle })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: search.open })).toHaveFocus();
  });

  it('groups results and opens the active one with Enter', async () => {
    api = stubApi({ 'GET /api/search?q=lop': () => ({ body: LOP }) });
    const { router, user } = renderPage();
    const combobox = await openAndType(user, 'lop');

    const listbox = screen.getByRole('listbox', { name: search.listLabel });
    const headings = within(listbox)
      .getAllByRole('group')
      .map((group) => document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent);
    expect(headings).toEqual([search.customers, search.jobs, search.addresses]);

    await user.keyboard('{ArrowDown}');
    const first = within(listbox).getAllByRole('option')[0]!;
    expect(combobox).toHaveAttribute('aria-activedescendant', first.id);
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveTextContent('Lopez Family');

    await user.keyboard('{Enter}');
    await waitFor(() => expect(where(router)).toBe('/customers/c1'));
    expect(screen.queryByRole('dialog', { name: search.dialogTitle })).not.toBeInTheDocument();
  });

  it('ignores the old results while the next query waits', async () => {
    api = stubApi({
      'GET /api/search?q=lop': () => ({ body: LOP }),
      'GET /api/search?q=lope': () => ({ body: EMPTY }),
    });
    const { router, user } = renderPage();
    const combobox = await openAndType(user, 'lop');
    await user.keyboard('{ArrowDown}');
    expect(combobox).toHaveAttribute('aria-activedescendant');

    // One more letter, then Enter, inside the 200ms debounce: the old list is off the screen, so Enter opens nothing
    await user.keyboard('e{Enter}');

    expect(where(router)).toBe('/');
    expect(screen.getByRole('dialog', { name: search.dialogTitle })).toBeInTheDocument();
    expect(combobox).not.toHaveAttribute('aria-activedescendant');
  });

  it('opens a job and an address from the keyboard', async () => {
    api = stubApi({ 'GET /api/search?q=lop': () => ({ body: LOP }) });

    const job = renderPage();
    await openAndType(job.user, 'lop');
    await job.user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() => expect(where(job.router)).toBe('/jobs/j1'));
    cleanup();

    const address = renderPage();
    const combobox = await openAndType(address.user, 'lop');
    await address.user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    const addressOption = within(screen.getByRole('group', { name: search.addresses })).getByRole('option');
    expect(combobox).toHaveAttribute('aria-activedescendant', addressOption.id);
    await address.user.keyboard('{Enter}');
    await waitFor(() => expect(where(address.router)).toBe('/customers/c1'));
    cleanup();

    // Up from nothing goes to the last result
    const last = renderPage();
    const lastCombobox = await openAndType(last.user, 'lop');
    await last.user.keyboard('{ArrowUp}');
    const lastOption = within(screen.getByRole('group', { name: search.addresses })).getByRole('option');
    expect(lastCombobox).toHaveAttribute('aria-activedescendant', lastOption.id);
    await last.user.keyboard('{Enter}');
    await waitFor(() => expect(where(last.router)).toBe('/customers/c1'));
  });

  it('opens a result on click', async () => {
    api = stubApi({ 'GET /api/search?q=lop': () => ({ body: LOP }) });
    const { router, user } = renderPage();
    await openAndType(user, 'lop');

    await user.click(within(screen.getByRole('group', { name: search.jobs })).getByRole('option'));

    await waitFor(() => expect(where(router)).toBe('/jobs/j1'));
  });

  it('waits for 2 characters', async () => {
    api = stubApi({ 'GET /api/search?q=lo': () => ({ body: EMPTY }) });
    const { user } = renderPage();
    const combobox = await openFromButton(user);

    await user.type(combobox, 'l');
    expect(await screen.findByText(search.hint)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(api.calls.some((call) => call.key.startsWith('GET /api/search'))).toBe(false);

    await user.type(combobox, 'o');
    await waitFor(() => expect(screen.queryByText(search.hint)).not.toBeInTheDocument());
    await waitFor(() => expect(api.count('GET /api/search?q=lo')).toBe(1));
  });

  it('shows no matches', async () => {
    api = stubApi({ 'GET /api/search?q=zzz': () => ({ body: EMPTY }) });
    const { user } = renderPage();
    const combobox = await openFromButton(user);

    await user.type(combobox, 'zzz');

    expect(await screen.findByText(search.noMatches('zzz'))).toBeInTheDocument();
  });

  it('sends the query as typed, encoded', async () => {
    api = stubApi({ "GET /api/search?q=o'neil%20%25": () => ({ body: EMPTY }) });
    const { user } = renderPage();
    const combobox = await openFromButton(user);

    await user.type(combobox, "o'neil %");

    expect(await screen.findByText(search.noMatches("o'neil %"))).toBeInTheDocument();
    const urls = api.calls.filter((call) => call.key.startsWith('GET /api/search')).map((call) => call.url);
    expect(urls).toEqual(["/api/search?q=o'neil%20%25"]);
    expect(new URLSearchParams(urls[0]!.split('?')[1]).get('q')).toBe("o'neil %");
  });

  it('asks once for a fast typist', async () => {
    api = stubApi({ 'GET /api/search?q=lop': () => ({ body: LOP }) });
    const { user } = renderPage();
    const combobox = await openFromButton(user);

    await user.type(combobox, 'lop');
    await screen.findByRole('group', { name: search.customers });

    expect(api.calls.filter((call) => call.key.startsWith('GET /api/search')).map((call) => call.key)).toEqual([
      'GET /api/search?q=lop',
    ]);
  });
});

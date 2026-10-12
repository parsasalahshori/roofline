import { cleanup, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '../src/api/types.ts';
import { shell } from '../src/copy/shell.ts';
import { UserMenu } from '../src/shell/topbar/UserMenu.tsx';
import { ACCOUNT, ACCOUNT_TWO, renderAt, SHELL_ROUTES, stubApi, USER, where } from './helpers.tsx';

/** The same person, after switching to the second company. */
const RIDGE_ACCOUNT: Account = {
  ...ACCOUNT_TWO,
  company: { id: 'c2', name: 'Ridge Roofing', slug: 'ridge-roofing', status: 'active' },
};

const SESSION_GONE = { status: 401, body: { error: 'Please sign in.' } };

/** Matches the name of any "switch to another company" entry: the copy's sentence with its company name left out. */
const startsLikeSwitch = (name: string) => name.startsWith(shell.switchTo(''));

let api: ReturnType<typeof stubApi>;
let restoreMatchMedia: (() => void) | undefined;

/** Makes the window phone-sized: every media query that is asked about matches. */
function stubPhone() {
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  restoreMatchMedia = () => {
    if (original) Object.defineProperty(window, 'matchMedia', original);
    else delete (window as { matchMedia?: unknown }).matchMedia;
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreMatchMedia?.();
  restoreMatchMedia = undefined;
  expect(api?.unexpected ?? []).toEqual([]);
});

/** Waits for the name on the account, then opens the menu from it. */
async function openMenu(user: UserEvent) {
  const trigger = await screen.findByRole('button', { name: USER.name });
  await user.click(trigger);
  return trigger;
}

describe('user menu', () => {
  it('shows the name and opens a menu with My day, Settings and Sign out', async () => {
    api = stubApi({ 'GET /api/auth/me': () => ({ body: ACCOUNT }), 'GET /api/setup': SHELL_ROUTES['GET /api/setup'] });
    const { user } = renderAt(<UserMenu />);

    const trigger = await screen.findByRole('button', { name: USER.name });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: shell.myDay })).toHaveAttribute('href', '/today');
    expect(screen.getByRole('link', { name: shell.settings })).toHaveAttribute('href', '/settings/company');
    expect(screen.getByRole('button', { name: shell.signOut })).toBeInTheDocument();
    // One company: nothing to switch to
    expect(screen.queryByRole('button', { name: startsLikeSwitch })).not.toBeInTheDocument();
  });

  it('switches company and goes to the map', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: ACCOUNT_TWO }),
      'GET /api/setup': SHELL_ROUTES['GET /api/setup'],
      'POST /api/auth/switch-company': () => ({ body: RIDGE_ACCOUNT }),
    });
    const { router, user } = renderAt(<UserMenu />, '/jobs');
    await openMenu(user);

    expect(screen.queryByRole('button', { name: shell.switchTo('Summit Roofing') })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: shell.switchTo('Ridge Roofing') }));

    await waitFor(() => expect(where(router)).toBe('/'));
    expect(api.sent('POST /api/auth/switch-company')).toEqual([{ companyId: 'c2' }]);
    expect(screen.queryByRole('button', { name: shell.signOut })).not.toBeInTheDocument();
  });

  it('signs out', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/setup': SHELL_ROUTES['GET /api/setup'],
      'POST /api/auth/logout': () => ({ body: { ok: true } }),
    });
    const { router, user } = renderAt(<UserMenu />, '/jobs');
    await openMenu(user);
    // Once signed out, asking who is signed in answers that the session is gone
    api.routes['GET /api/auth/me'] = () => SESSION_GONE;

    await user.click(screen.getByRole('button', { name: shell.signOut }));

    await waitFor(() => expect(where(router)).toBe('/sign-in'));
    expect(api.count('POST /api/auth/logout')).toBe(1);
  });

  it('opens My day and closes', async () => {
    api = stubApi({ 'GET /api/auth/me': () => ({ body: ACCOUNT }), 'GET /api/setup': SHELL_ROUTES['GET /api/setup'] });
    const { router, user } = renderAt(<UserMenu />, '/jobs');
    await openMenu(user);

    await user.click(screen.getByRole('link', { name: shell.myDay }));

    await waitFor(() => expect(where(router)).toBe('/today'));
    expect(screen.queryByRole('link', { name: shell.myDay })).not.toBeInTheDocument();
  });

  it('closes on Esc and returns focus to the name', async () => {
    api = stubApi({ 'GET /api/auth/me': () => ({ body: ACCOUNT }), 'GET /api/setup': SHELL_ROUTES['GET /api/setup'] });
    const { user } = renderAt(<UserMenu />);
    const trigger = await openMenu(user);
    expect(screen.getByRole('link', { name: shell.myDay })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('link', { name: shell.myDay })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes when the page behind is clicked', async () => {
    api = stubApi({ 'GET /api/auth/me': () => ({ body: ACCOUNT }), 'GET /api/setup': SHELL_ROUTES['GET /api/setup'] });
    const { user } = renderAt(
      <>
        <UserMenu />
        <p>Page behind</p>
      </>,
    );
    await openMenu(user);
    expect(screen.getByRole('link', { name: shell.myDay })).toBeInTheDocument();

    await user.click(screen.getByText('Page behind'));

    expect(screen.queryByRole('link', { name: shell.myDay })).not.toBeInTheDocument();
  });

  it('is not a dialog on desktop', async () => {
    api = stubApi({ 'GET /api/auth/me': () => ({ body: ACCOUNT }), 'GET /api/setup': SHELL_ROUTES['GET /api/setup'] });
    const { user } = renderAt(<UserMenu />);
    await openMenu(user);

    expect(screen.getByRole('link', { name: shell.myDay })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens a sheet on a phone', async () => {
    stubPhone();
    api = stubApi({ 'GET /api/auth/me': () => ({ body: ACCOUNT }), 'GET /api/setup': SHELL_ROUTES['GET /api/setup'] });
    const { user } = renderAt(<UserMenu />, '/jobs');
    await openMenu(user);

    const sheet = await screen.findByRole('dialog', { name: shell.menuLabel });
    expect(within(sheet).getByRole('link', { name: shell.myDay })).toHaveAttribute('href', '/today');
    expect(within(sheet).getByRole('link', { name: shell.settings })).toHaveAttribute('href', '/settings/company');
    expect(within(sheet).getByRole('button', { name: shell.signOut })).toBeInTheDocument();
  });
});

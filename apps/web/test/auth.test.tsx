import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { createMemoryRouter, RouterProvider } from 'react-router';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, setUnauthorizedHandler } from '../src/api/client.ts';
import { useSignOut, useSwitchCompany } from '../src/api/hooks.ts';
import { keys } from '../src/api/keys.ts';
import type { Account } from '../src/api/types.ts';
import { redirectToSignIn, resetSignInRedirect } from '../src/app/RequireSession.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { auth } from '../src/copy/auth.ts';
import { common } from '../src/copy/common.ts';
import { dock } from '../src/copy/dock.ts';
import { errors } from '../src/copy/errors.ts';
import { ACCOUNT, COMPANY, SHELL_ROUTES, stubApi as stubApiBase, type Routes, USER } from './helpers.tsx';

// The real map loads maplibre-gl, which these tests never need
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

const OTHER_COMPANY: Account['company'] = { id: 'c2', name: 'Ridge Roofing', slug: 'ridge-roofing', status: 'active' };

const BAD_LOGIN = "That email and password don't match.";
const SIGN_IN_FIRST = 'Sign in to accept this invite.';

/** The shell's reads (Task 12) are answered with "nothing" unless a test gives its own answer. */
const stubApi = (given: Routes) => stubApiBase({ ...SHELL_ROUTES, ...given });

function renderApp(path: string, { strict = false } = {}) {
  const queryClient = createQueryClient();
  const router = createAppRouter({ initialEntries: [path] });
  const tree = (
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { router, queryClient, user: userEvent.setup() };
}

const where = (router: { state: { location: { pathname: string; search: string } } }) =>
  router.state.location.pathname + router.state.location.search;

let api: ReturnType<typeof stubApi>;

beforeEach(() => {
  setUnauthorizedHandler(() => {});
  // The redirect guard is module state: a test that ended on the way to sign-in must not leave it set
  resetSignInRedirect();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(api?.unexpected ?? []).toEqual([]);
});

describe('sign-in', () => {
  async function submitSignIn(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText(auth.email), 'sam@example.com');
    await user.type(screen.getByLabelText(auth.password), 'a long password');
    await user.click(screen.getByRole('button', { name: auth.signIn }));
  }

  it('signs in and goes to next', async () => {
    api = stubApi({
      'POST /api/auth/login': () => ({ body: { user: USER, company: COMPANY } }),
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/approvals/t1': () => ({ status: 404, body: { error: 'Not found' } }),
    });
    const { router, user } = renderApp('/sign-in?next=/approvals/t1');

    await submitSignIn(user);

    await waitFor(() => expect(where(router)).toBe('/approvals/t1'));
    expect(api.sent('POST /api/auth/login')).toEqual([{ email: 'sam@example.com', password: 'a long password' }]);
    // The page behind the sign-in opens once the session is confirmed
    expect(await screen.findByRole('navigation', { name: dock.label })).toBeInTheDocument();
  });

  it('ignores an unsafe next', async () => {
    api = stubApi({
      'POST /api/auth/login': () => ({ body: { user: USER, company: COMPANY } }),
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
    });
    const { router, user } = renderApp('/sign-in?next=//evil.example');

    await submitSignIn(user);

    await waitFor(() => expect(where(router)).toBe('/'));
  });

  it('redirects to sign-in with next when the session is gone', async () => {
    api = stubApi({ 'GET /api/auth/me': () => ({ status: 401, body: { error: 'Please sign in.' } }) });
    const { router } = renderApp('/approvals/t1');

    await waitFor(() => expect(where(router)).toBe('/sign-in?next=%2Fapprovals%2Ft1'));
    expect(await screen.findByRole('button', { name: auth.signIn })).toBeInTheDocument();
  });

  it('keeps the query string in next', async () => {
    api = stubApi({ 'GET /api/auth/me': () => ({ status: 401, body: { error: 'Please sign in.' } }) });
    const { router } = renderApp('/jobs?stage=won');

    await waitFor(() => expect(where(router)).toBe('/sign-in?next=%2Fjobs%3Fstage%3Dwon'));
  });

  it('shows a field error next to the field', async () => {
    api = stubApi({ 'POST /api/auth/login': () => ({ status: 401, body: { error: BAD_LOGIN } }) });
    const { router, user } = renderApp('/sign-in');

    await submitSignIn(user);

    // A message with no field is an alert on the form, and a wrong password stays on this page
    const alert = (await screen.findByText(BAD_LOGIN)).closest('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(screen.getByLabelText(auth.email)).not.toHaveAccessibleDescription(BAD_LOGIN);
    expect(where(router)).toBe('/sign-in');

    // A message with a field sits under that field
    api.routes['POST /api/auth/login'] = () => ({ status: 400, body: { error: 'Please enter a valid email.', field: 'email' } });
    await user.click(screen.getByRole('button', { name: auth.signIn }));

    await waitFor(() => expect(screen.getByLabelText(auth.email)).toHaveAccessibleDescription('Please enter a valid email.'));
    expect(screen.getByLabelText(auth.email)).toBeInvalid();
    expect(screen.getByLabelText(auth.password)).toBeValid();
    expect(screen.queryByText(BAD_LOGIN)).not.toBeInTheDocument();
    expect(where(router)).toBe('/sign-in');
  });

  it('shows the lost connection in the form', async () => {
    api = stubApi({});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { user } = renderApp('/sign-in');

    await submitSignIn(user);

    expect((await screen.findByText(common.networkError)).closest('[role="alert"]')).not.toBeNull();
  });

  it('links to the password reset', async () => {
    api = stubApi({});
    renderApp('/sign-in');

    expect(await screen.findByRole('link', { name: auth.forgot })).toHaveAttribute('href', '/reset');
  });
});

describe('the session redirect', () => {
  it('redirects once when several requests come back 401 together', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'GET /api/other': () => ({ status: 401, body: { error: 'Please sign in.' } }),
      'GET /api/approvals/t1': () => ({ status: 404, body: { error: 'Not found' } }),
    });
    const { router } = renderApp('/approvals/t1');
    await screen.findByRole('navigation', { name: dock.label });
    const navigate = vi.spyOn(router, 'navigate');

    await Promise.allSettled([apiFetch('/api/other'), apiFetch('/api/other'), apiFetch('/api/other')]);

    await waitFor(() => expect(where(router)).toBe('/sign-in?next=%2Fapprovals%2Ft1'));
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('sends the person once, however often it is asked, until the sign-in page opens', () => {
    const navigate = vi.fn();
    const router = { navigate, state: { location: { pathname: '/approvals/t1', search: '?tab=steps' } } };

    redirectToSignIn(router);
    redirectToSignIn(router);
    redirectToSignIn(router);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/sign-in?next=%2Fapprovals%2Ft1%3Ftab%3Dsteps', { replace: true });

    resetSignInRedirect();
    redirectToSignIn(router);
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('does not send a person who is already signing in somewhere else', async () => {
    api = stubApi({ 'GET /api/other': () => ({ status: 401, body: { error: 'Please sign in.' } }) });
    const { router } = renderApp('/sign-in');
    await screen.findByRole('button', { name: auth.signIn });
    const navigate = vi.spyOn(router, 'navigate');

    await Promise.allSettled([apiFetch('/api/other')]);

    expect(navigate).not.toHaveBeenCalled();
    expect(where(router)).toBe('/sign-in');
  });

  it('redirects again after the person has been back to the sign-in page', async () => {
    api = stubApi({
      'GET /api/auth/me': () => ({ body: ACCOUNT }),
      'POST /api/auth/login': () => ({ body: { user: USER, company: COMPANY } }),
      'GET /api/other': () => ({ status: 401, body: { error: 'Please sign in.' } }),
    });
    const { router, user } = renderApp('/jobs');
    await screen.findByRole('navigation', { name: dock.label });

    await Promise.allSettled([apiFetch('/api/other')]);
    await waitFor(() => expect(where(router)).toBe('/sign-in?next=%2Fjobs'));
    await user.type(await screen.findByLabelText(auth.email), 'sam@example.com');
    await user.type(screen.getByLabelText(auth.password), 'a long password');
    await user.click(screen.getByRole('button', { name: auth.signIn }));
    await waitFor(() => expect(where(router)).toBe('/jobs'));
    await screen.findByRole('navigation', { name: dock.label });

    await Promise.allSettled([apiFetch('/api/other')]);
    await waitFor(() => expect(where(router)).toBe('/sign-in?next=%2Fjobs'));
  });

  it('offers another try when the session check fails for a reason other than a lost session', async () => {
    api = stubApi({ 'GET /api/auth/me': () => ({ status: 500, body: { error: 'We hit a snag on our side.' } }) });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createAppRouter({ initialEntries: ['/jobs'] });
    const user = userEvent.setup();
    render(
      <Providers client={client}>
        <RouterProvider router={router} />
      </Providers>,
    );

    expect((await screen.findByText('We hit a snag on our side.')).closest('[role="alert"]')).not.toBeNull();
    // Not a lost session: the person stays where they were, and the page behind it does not open
    expect(where(router)).toBe('/jobs');
    expect(screen.queryByRole('navigation', { name: dock.label })).not.toBeInTheDocument();

    api.routes['GET /api/auth/me'] = () => ({ body: ACCOUNT });
    await user.click(screen.getByRole('button', { name: errors.tryAgain }));

    expect(await screen.findByRole('navigation', { name: dock.label })).toBeInTheDocument();
    expect(where(router)).toBe('/jobs');
  });
});

describe('query defaults', () => {
  it('retries a failed read twice, but never one the server refused with a 4xx', () => {
    const queries = createQueryClient().getDefaultOptions().queries;
    const retry = queries?.retry as (failureCount: number, error: Error) => boolean;
    expect(retry(0, new ApiError(404, 'x'))).toBe(false);
    expect(retry(0, new ApiError(401, 'x'))).toBe(false);
    expect(retry(0, new ApiError(500, 'x'))).toBe(true);
    expect(retry(0, new ApiError(0, 'x'))).toBe(true);
    expect(retry(1, new TypeError('x'))).toBe(true);
    expect(retry(2, new ApiError(500, 'x'))).toBe(false);
    expect(queries?.refetchOnWindowFocus).toBe(true);
  });
});

describe('reset password', () => {
  it('asks for the email and says a link is on its way, whoever the email is', async () => {
    api = stubApi({ 'POST /api/auth/reset-request': () => ({ body: { ok: true } }) });
    const { user } = renderApp('/reset');

    await user.type(await screen.findByLabelText(auth.email), 'nobody@example.com');
    await user.click(screen.getByRole('button', { name: auth.sendLink }));

    expect(await screen.findByText(auth.resetSent)).toBeInTheDocument();
    expect(api.sent('POST /api/auth/reset-request')).toEqual([{ email: 'nobody@example.com' }]);
    expect(screen.getByRole('link', { name: auth.backToSignIn })).toHaveAttribute('href', '/sign-in');
  });

  it('puts a refused email under the email field and does not claim a link was sent', async () => {
    api = stubApi({
      'POST /api/auth/reset-request': () => ({ status: 400, body: { error: 'Please enter a valid email.', field: 'email' } }),
    });
    const { user } = renderApp('/reset');

    await user.type(await screen.findByLabelText(auth.email), 'nope');
    await user.click(screen.getByRole('button', { name: auth.sendLink }));

    await waitFor(() => expect(screen.getByLabelText(auth.email)).toHaveAccessibleDescription('Please enter a valid email.'));
    expect(screen.queryByText(auth.resetSent)).not.toBeInTheDocument();
  });

  it('takes the new password when the link has a token, then links to sign-in', async () => {
    api = stubApi({ 'POST /api/auth/reset': () => ({ body: { ok: true } }) });
    const { user } = renderApp('/reset?token=abc_123-x');

    await user.type(await screen.findByLabelText(auth.newPassword), 'a brand new password');
    await user.click(screen.getByRole('button', { name: auth.savePassword }));

    expect(await screen.findByText(auth.passwordChanged)).toBeInTheDocument();
    expect(api.sent('POST /api/auth/reset')).toEqual([{ token: 'abc_123-x', password: 'a brand new password' }]);
    expect(screen.getByRole('link', { name: auth.signIn })).toHaveAttribute('href', '/sign-in');
  });

  it('shows the password rule next to the password and the dead-link message with a way to ask again', async () => {
    api = stubApi({
      'POST /api/auth/reset': () => ({ status: 400, body: { error: 'Use at least 10 characters for your password.', field: 'password' } }),
    });
    const { user } = renderApp('/reset?token=abc');

    await user.type(await screen.findByLabelText(auth.newPassword), 'short');
    await user.click(screen.getByRole('button', { name: auth.savePassword }));
    await waitFor(() =>
      expect(screen.getByLabelText(auth.newPassword)).toHaveAccessibleDescription(expect.stringContaining('Use at least 10 characters for your password.')),
    );

    api.routes['POST /api/auth/reset'] = () => ({ status: 400, body: { error: 'That link has already been used or has expired.' } });
    await user.click(screen.getByRole('button', { name: auth.savePassword }));

    expect((await screen.findByText('That link has already been used or has expired.')).closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByRole('link', { name: auth.askNewLink })).toHaveAttribute('href', '/reset');
  });
});

describe('verify email', () => {
  it('confirms the address once on arrival, even when the page renders twice', async () => {
    api = stubApi({ 'POST /api/auth/verify-email': () => ({ body: { ok: true } }) });
    renderApp('/verify?token=tok1', { strict: true });

    expect(await screen.findByText(auth.emailConfirmed)).toBeInTheDocument();
    expect(api.sent('POST /api/auth/verify-email')).toEqual([{ token: 'tok1' }]);
    expect(screen.getByRole('link', { name: auth.continue })).toHaveAttribute('href', '/');
  });

  it('shows the message when the link is no good', async () => {
    api = stubApi({
      'POST /api/auth/verify-email': () => ({ status: 400, body: { error: 'That link has already been used or has expired.' } }),
    });
    renderApp('/verify?token=old');

    expect((await screen.findByText('That link has already been used or has expired.')).closest('[role="alert"]')).not.toBeNull();
    expect(screen.queryByText(auth.emailConfirmed)).not.toBeInTheDocument();
  });

  it('says the link is incomplete, and asks for nothing, when there is no token', async () => {
    api = stubApi({});
    renderApp('/verify');

    expect(await screen.findByText(auth.linkIncomplete)).toBeInTheDocument();
    expect(api.sent('POST /api/auth/verify-email')).toEqual([]);
  });
});

describe('accept invite', () => {
  it('makes the account, lands on the home page and keeps the session', async () => {
    api = stubApi({ 'POST /api/auth/accept-invite': () => ({ body: ACCOUNT }) });
    const { router, queryClient, user } = renderApp('/invite?token=inv1');

    await user.type(await screen.findByLabelText(auth.name), 'Sam Roofer');
    await user.type(screen.getByLabelText(auth.password), 'a long password');
    await user.click(screen.getByRole('button', { name: auth.acceptInvite }));

    await waitFor(() => expect(where(router)).toBe('/'));
    expect(api.sent('POST /api/auth/accept-invite')).toEqual([{ token: 'inv1', name: 'Sam Roofer', password: 'a long password' }]);
    expect(queryClient.getQueryData(keys.me)).toEqual(ACCOUNT);
    // The session is already known, so the home page does not ask the server who this is
    expect(await screen.findByRole('navigation', { name: dock.label })).toBeInTheDocument();
  });

  it('asks an existing account to sign in first, and comes back to the invite after', async () => {
    api = stubApi({ 'POST /api/auth/accept-invite': () => ({ status: 401, body: { error: SIGN_IN_FIRST } }) });
    const { router, user } = renderApp('/invite?token=inv1');

    await user.type(await screen.findByLabelText(auth.name), 'Sam Roofer');
    await user.type(screen.getByLabelText(auth.password), 'a long password');
    await user.click(screen.getByRole('button', { name: auth.acceptInvite }));

    expect((await screen.findByText(SIGN_IN_FIRST)).closest('[role="alert"]')).not.toBeNull();
    // This page's own 401 is not a lost session: no redirect
    expect(where(router)).toBe('/invite?token=inv1');
    expect(screen.getByRole('link', { name: auth.signInToJoin })).toHaveAttribute('href', '/sign-in?next=%2Finvite%3Ftoken%3Dinv1');
  });

  it('shows the message for an invite that is gone, and for one already accepted', async () => {
    api = stubApi({
      'POST /api/auth/accept-invite': () => ({ status: 400, body: { error: 'That invite link has expired or was already used. Ask for a new one.' } }),
    });
    const { user } = renderApp('/invite?token=inv1');

    await user.type(await screen.findByLabelText(auth.name), 'Sam Roofer');
    await user.type(screen.getByLabelText(auth.password), 'a long password');
    await user.click(screen.getByRole('button', { name: auth.acceptInvite }));
    expect(await screen.findByText('That invite link has expired or was already used. Ask for a new one.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: auth.signInToJoin })).not.toBeInTheDocument();

    api.routes['POST /api/auth/accept-invite'] = () => ({ status: 409, body: { error: "You're already on this team." } });
    await user.click(screen.getByRole('button', { name: auth.acceptInvite }));
    expect(await screen.findByText("You're already on this team.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: auth.continue })).toHaveAttribute('href', '/');
  });

  it('puts field errors on the name and the password', async () => {
    api = stubApi({
      'POST /api/auth/accept-invite': ({ body }) => {
        const { name } = body as { name: string };
        return name === ''
          ? { status: 400, body: { error: 'Please enter a name.', field: 'name' } }
          : { status: 400, body: { error: 'Use at least 10 characters for your password.', field: 'password' } };
      },
    });
    const { user } = renderApp('/invite?token=inv1');

    await user.type(await screen.findByLabelText(auth.password), 'short');
    await user.click(screen.getByRole('button', { name: auth.acceptInvite }));
    await waitFor(() => expect(screen.getByLabelText(auth.name)).toHaveAccessibleDescription('Please enter a name.'));

    await user.type(screen.getByLabelText(auth.name), 'Sam');
    await user.click(screen.getByRole('button', { name: auth.acceptInvite }));
    await waitFor(() =>
      expect(screen.getByLabelText(auth.password)).toHaveAccessibleDescription(expect.stringContaining('Use at least 10 characters for your password.')),
    );
  });

  it('says the link is incomplete when there is no token', async () => {
    api = stubApi({});
    renderApp('/invite');

    expect(await screen.findByText(auth.linkIncomplete)).toBeInTheDocument();
    expect(screen.queryByLabelText(auth.name)).not.toBeInTheDocument();
  });
});

describe('session hooks', () => {
  const OTHER_ACCOUNT: Account = { ...ACCOUNT, company: OTHER_COMPANY };

  function Harness() {
    const signOut = useSignOut();
    const switchCompany = useSwitchCompany();
    return (
      <div>
        <button onClick={() => signOut.mutate()}>sign out</button>
        <button onClick={() => switchCompany.mutate('c2')}>switch</button>
      </div>
    );
  }

  function renderHarness() {
    const queryClient = createQueryClient();
    queryClient.setQueryData(keys.me, ACCOUNT);
    queryClient.setQueryData(keys.approvals, { count: 0, tasks: [] });
    const router = createMemoryRouter(
      [
        { path: '/', element: <Harness /> },
        { path: '/sign-in', element: <p>signed out</p> },
      ],
      { initialEntries: ['/'] },
    );
    render(
      <Providers client={queryClient}>
        <RouterProvider router={router} />
      </Providers>,
    );
    return { queryClient, router, user: userEvent.setup() };
  }

  it('clears every query and goes to the sign-in page on sign-out', async () => {
    api = stubApi({ 'POST /api/auth/logout': () => ({ body: { ok: true } }) });
    const { queryClient, router, user } = renderHarness();

    await user.click(screen.getByRole('button', { name: 'sign out' }));

    await waitFor(() => expect(where(router)).toBe('/sign-in'));
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
  });

  it('counts a session that is already gone as signed out', async () => {
    api = stubApi({ 'POST /api/auth/logout': () => ({ status: 401, body: { error: 'Please sign in.' } }) });
    const { queryClient, router, user } = renderHarness();

    await user.click(screen.getByRole('button', { name: 'sign out' }));

    await waitFor(() => expect(where(router)).toBe('/sign-in'));
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
  });

  it('takes the new account on a company switch and marks everything else stale', async () => {
    api = stubApi({ 'POST /api/auth/switch-company': () => ({ body: OTHER_ACCOUNT }) });
    const { queryClient, user } = renderHarness();

    await user.click(screen.getByRole('button', { name: 'switch' }));

    await waitFor(() => expect(queryClient.getQueryData(keys.me)).toEqual(OTHER_ACCOUNT));
    expect(api.sent('POST /api/auth/switch-company')).toEqual([{ companyId: 'c2' }]);
    await waitFor(() => expect(queryClient.getQueryData(keys.approvals)).toBeUndefined());
  });
});

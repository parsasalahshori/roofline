import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setUnauthorizedHandler } from '../src/api/client.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { resetSignInRedirect } from '../src/app/RequireSession.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { auth } from '../src/copy/auth.ts';
import { ACCOUNT, SHELL_ROUTES, stubApi as stubApiBase, where, type Routes } from './helpers.tsx';

// The real map loads maplibre-gl, which these tests never need
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

const NO_SESSION = { status: 401, body: { error: 'Sign in' } };
const NO_GOOGLE = { body: { googleClientId: null } };
const TAKEN = 'That email already has an account.';
const NO_ADDRESS = 'We could not find that address.';

const PERSON = { name: 'Sam Roofer', email: 'sam@example.com', password: 'a long password' };
const COMPANY = { companyName: 'Summit Roofing', companyPhone: '(555) 010-2030', companyAddress: '12 Oak St, Dallas, TX 75201' };

let api: ReturnType<typeof stubApiBase>;

/** Renders the real app at `path` with the given answers on top of the defaults. */
function renderSignUp(routes: Routes = {}, path = '/sign-up') {
  api = stubApiBase({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => NO_SESSION,
    'GET /api/auth/config': () => NO_GOOGLE,
    ...routes,
  });
  const queryClient = createQueryClient();
  const router = createAppRouter({ initialEntries: [path] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, user: userEvent.setup() };
}

type Person = ReturnType<typeof userEvent.setup>;

/** Step 1: who the person is. Ends by pressing Continue. */
async function fillAccount(user: Person, person = PERSON) {
  await user.type(await screen.findByLabelText(auth.yourName), person.name);
  await user.type(screen.getByLabelText(auth.email), person.email);
  await user.type(screen.getByLabelText(auth.password), person.password);
  await user.click(screen.getByRole('button', { name: auth.continue }));
}

/** Step 2: the company. Leaves the form as it is, ready to submit. */
async function fillCompany(user: Person, company = COMPANY) {
  await user.type(await screen.findByLabelText(auth.companyName), company.companyName);
  await user.type(screen.getByLabelText(auth.businessPhone), company.companyPhone);
  await user.type(screen.getByLabelText(auth.businessAddress), company.companyAddress);
}

type GoogleCallback = (response: { credential: string }) => void;

/** A stand-in for Google's script: keeps the callback the page gives it, so a test can answer as Google does. */
let captured: GoogleCallback | null = null;

function installGoogle() {
  captured = null;
  const initialize = vi.fn((config: { callback: GoogleCallback }) => {
    captured = config.callback;
  });
  window.google = { accounts: { id: { initialize, renderButton: vi.fn() } } };
  return initialize;
}

function googleCallback(): GoogleCallback {
  if (captured === null) throw new Error('Google has not given the page a callback');
  return captured;
}

beforeEach(() => {
  setUnauthorizedHandler(() => {});
  resetSignInRedirect();
});

afterEach(() => {
  cleanup();
  delete window.google;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(api?.unexpected ?? []).toEqual([]);
});

it('signs up in two steps and opens Setup', async () => {
  const { router, user } = renderSignUp({
    'POST /api/auth/signup': () => ({ status: 201, body: {} }),
  });
  // The session is confirmed once the account exists: Setup reads it
  api.routes['GET /api/auth/me'] = () => ({ body: ACCOUNT });
  await fillAccount(user);
  await fillCompany(user);

  await user.click(screen.getByRole('button', { name: auth.startTrial }));

  await waitFor(() => expect(where(router)).toBe('/settings/setup'));
  const sent = api.sent('POST /api/auth/signup');
  expect(sent).toHaveLength(1);
  expect(Object.keys(sent[0] as object).sort()).toEqual(['companyAddress', 'companyName', 'companyPhone', 'email', 'name', 'password']);
  expect(sent[0]).toEqual({ name: PERSON.name, email: PERSON.email, password: PERSON.password, ...COMPANY });
});

it('shows a taken email back on step 1', async () => {
  const { user } = renderSignUp({
    'POST /api/auth/signup': () => ({ status: 409, body: { error: TAKEN, field: 'email' } }),
  });
  await fillAccount(user);
  await fillCompany(user);

  await user.click(screen.getByRole('button', { name: auth.startTrial }));

  // Back on step 1, with what was typed still there and the message under Email
  await waitFor(() => expect(screen.getByLabelText(auth.email)).toHaveAccessibleDescription(TAKEN));
  expect(screen.getByLabelText(auth.yourName)).toHaveValue(PERSON.name);
  expect(screen.queryByLabelText(auth.businessAddress)).not.toBeInTheDocument();
});

it('shows an address problem on step 2', async () => {
  const { user } = renderSignUp({
    'POST /api/auth/signup': () => ({ status: 400, body: { error: NO_ADDRESS, field: 'companyAddress' } }),
  });
  await fillAccount(user);
  await fillCompany(user);

  await user.click(screen.getByRole('button', { name: auth.startTrial }));

  await waitFor(() => expect(screen.getByLabelText(auth.businessAddress)).toHaveAccessibleDescription(expect.stringContaining(NO_ADDRESS)));
  // Still on step 2
  expect(screen.queryByLabelText(auth.yourName)).not.toBeInTheDocument();
});

it('Google: an existing account goes to the map, a new one asks for the company', async () => {
  // Existing account: Google's credential is enough, and the page goes to the map
  const initialize = installGoogle();
  const existing = renderSignUp({
    'GET /api/auth/config': () => ({ body: { googleClientId: 'client-1' } }),
    'POST /api/auth/google': () => ({ status: 200, body: {} }),
  });
  api.routes['GET /api/auth/me'] = () => ({ body: ACCOUNT });
  await waitFor(() => expect(initialize).toHaveBeenCalled());

  act(() => {
    googleCallback()({ credential: 'cred-1' });
  });

  await waitFor(() => expect(where(existing.router)).toBe('/'));
  expect(api.sent('POST /api/auth/google')).toEqual([{ credential: 'cred-1' }]);

  // A new account: Google's answer names companyName, so the page asks for the company, then sends it all
  cleanup();
  const fresh = installGoogle();
  const newcomer = renderSignUp({
    'GET /api/auth/config': () => ({ body: { googleClientId: 'client-1' } }),
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'POST /api/auth/google': ({ body }) =>
      (body as { companyName?: string }).companyName === undefined
        ? { status: 400, body: { error: 'Tell us your company name.', field: 'companyName' } }
        : { status: 200, body: {} },
  });
  await waitFor(() => expect(fresh).toHaveBeenCalled());

  act(() => {
    googleCallback()({ credential: 'cred-1' });
  });

  await screen.findByLabelText(auth.companyName);
  expect(screen.queryByLabelText(auth.yourName)).not.toBeInTheDocument();
  await fillCompany(newcomer.user);
  await newcomer.user.click(screen.getByRole('button', { name: auth.startTrial }));

  await waitFor(() => expect(where(newcomer.router)).toBe('/'));
  expect(api.sent('POST /api/auth/google')).toEqual([
    { credential: 'cred-1' },
    { credential: 'cred-1', ...COMPANY },
  ]);
});

it('step 2 has three inputs', async () => {
  const { user } = renderSignUp();
  await fillAccount(user);

  const form = (await screen.findByLabelText(auth.businessAddress)).closest('form');
  expect(form).not.toBeNull();
  expect(within(form as HTMLFormElement).getAllByRole('textbox')).toHaveLength(3);
});

it('sign-in links to sign-up and offers Google, which sends a new account to sign-up', async () => {
  const initialize = installGoogle();
  const { router } = renderSignUp(
    {
      'GET /api/auth/config': () => ({ body: { googleClientId: 'client-1' } }),
      'POST /api/auth/google': () => ({ status: 400, body: { error: 'Tell us your company name.', field: 'companyName' } }),
    },
    '/sign-in',
  );

  expect(await screen.findByRole('link', { name: auth.createAccount })).toHaveAttribute('href', '/sign-up');
  await waitFor(() => expect(initialize).toHaveBeenCalled());

  act(() => {
    googleCallback()({ credential: 'cred-1' });
  });

  await waitFor(() => expect(where(router)).toBe('/sign-up'));
  expect(api.sent('POST /api/auth/google')).toEqual([{ credential: 'cred-1' }]);
});

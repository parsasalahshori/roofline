import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StormPhoto, StormSettingsBody, StormSettingsPatch } from '../src/api/types.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { connections } from '../src/copy/connections.ts';
import { errors } from '../src/copy/errors.ts';
import { settings as settingsCopy } from '../src/copy/settings.ts';
import { storm } from '../src/copy/storm.ts';
import { Settings } from '../src/features/settings/Settings.tsx';
import { ACCOUNT, type Routes, stubApi } from './helpers.tsx';

const DEFAULT_SMS =
  "Hi {first_name}, it's {company}. Radar shows hail up to {hail_size} hit near your home on {street} {day}. Want a free roof check this week? Reply YES to book. Reply STOP to opt out.";
const DEFAULT_SUBJECT = 'Hail near your home on {street}';
const DEFAULT_EMAIL = [
  'Hi {first_name},',
  '',
  'Radar shows hail up to {hail_size} hit near your home on {street} {day}.',
  '',
  'Want a free roof check this week? Reply to this email to book.',
  '',
  '{company}',
  '{company_address}',
  'Unsubscribe: {unsubscribe}',
].join('\n');

/** What the company saved: each template differs from the standard text. */
const CUSTOM_SMS = 'Hi {first_name}, {company} here. Hail hit near {street}. Reply STOP to opt out.';
const CUSTOM_SUBJECT = 'Storm check for {street}';
const CUSTOM_EMAIL = 'Hi {first_name}, {company} at {company_address}. {unsubscribe}';

const KB = 1024;
const MB = 1024 * KB;

/** The company's storm settings as the server holds them. Each test gets a fresh copy. */
let server: StormSettingsBody;
/** What the photo wrapper has been sent, in order. */
let uploads: { type: string; body: unknown }[];
let deletes: string[];
let api: ReturnType<typeof stubApi>;

function freshServer(): StormSettingsBody {
  return {
    thresholdIn: 1,
    adBudgetCents: 25000,
    adDays: 7,
    adGoogleSharePct: 60,
    emailEnabled: true,
    smsTemplate: CUSTOM_SMS,
    emailSubject: CUSTOM_SUBJECT,
    emailTemplate: CUSTOM_EMAIL,
    defaults: { smsTemplate: DEFAULT_SMS, emailSubject: DEFAULT_SUBJECT, emailTemplate: DEFAULT_EMAIL },
    photos: [],
    maxPhotos: 5,
  };
}

const photo = (id: string): StormPhoto => ({ id, url: `/api/storm/photos/${id}/file`, createdAt: '2026-10-10T12:00:00.000Z' });

beforeEach(() => {
  server = freshServer();
  uploads = [];
  deletes = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/**
 * Stands in for the API: the JSON routes go through stubApi; the photo routes are answered here,
 * since a File body and a 204 with no body are not what stubApi's JSON answers can carry.
 * `routes` may replace any answer for a test.
 */
function stubStorm(routes: Routes = {}) {
  api = stubApi({
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/storm/settings': () => ({ body: server }),
    'PUT /api/storm/settings': ({ body }) => {
      Object.assign(server, body as StormSettingsPatch);
      return { body: server };
    },
    ...routes,
  });
  const delegate = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url === '/api/storm/photos') {
        const headers = init?.headers as Record<string, string>;
        uploads.push({ type: headers['Content-Type'] ?? '', body: init?.body });
        const created = photo(`p${server.photos.length + 1}`);
        server.photos = [...server.photos, created];
        return Promise.resolve(new Response(JSON.stringify(created), { status: 201, headers: { 'content-type': 'application/json' } }));
      }
      if (method === 'DELETE' && url.startsWith('/api/storm/photos/')) {
        const id = url.slice('/api/storm/photos/'.length);
        deletes.push(id);
        server.photos = server.photos.filter((candidate) => candidate.id !== id);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return delegate(input, init);
    }),
  );
  return api;
}

/** The Settings window for the owner, on the Storm tab, as the app routes it. */
function renderStormTab() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter([{ path: '/settings/:tab', element: <Settings /> }], { initialEntries: ['/settings/storm'] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, queryClient, user: userEvent.setup() };
}

const saveButton = () => screen.getByRole('button', { name: storm.settings.save });
const saveBar = () => screen.queryByRole('group', { name: settingsCopy.saveBar.label });

it('storm tab loads the saved settings', async () => {
  stubStorm();
  renderStormTab();

  // The threshold is a list that opens: it shows the one in use
  expect(await screen.findByLabelText(storm.settings.thresholdLabel)).toHaveTextContent(storm.settings.thresholdOption(1));
  expect(screen.getByLabelText(storm.settings.budgetLabel)).toHaveValue('250.00');
  expect(screen.getByLabelText(storm.settings.daysLabel)).toHaveValue(7);
  expect((screen.getByLabelText(connections.googleShareLabel) as HTMLInputElement).value).toBe('60');
  expect(screen.getByText('60%')).toBeInTheDocument();
  expect(screen.getByText('40%')).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: storm.settings.emailsLabel })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByLabelText(storm.settings.smsLabel)).toHaveValue(CUSTOM_SMS);
  expect(screen.getByLabelText(storm.settings.emailSubjectLabel)).toHaveValue(CUSTOM_SUBJECT);
  expect(screen.getByLabelText(storm.settings.emailLabel)).toHaveValue(CUSTOM_EMAIL);
});

it('storm tab saves a changed threshold and budget with a PUT of only the changed fields', async () => {
  stubStorm();
  const { user } = renderStormTab();

  await user.click(await screen.findByLabelText(storm.settings.thresholdLabel));
  await user.click(screen.getByRole('option', { name: storm.settings.thresholdOption(1.5) }));
  const budget = screen.getByLabelText(storm.settings.budgetLabel);
  await user.clear(budget);
  await user.type(budget, '300');
  await user.click(saveButton());

  await waitFor(() => expect(api.sent('PUT /api/storm/settings')).toEqual([{ thresholdIn: 1.5, adBudgetCents: 30000 }]));
  await screen.findByText(storm.settings.saved);
});

it('storm tab shows a server validation error under the field', async () => {
  stubStorm({
    'PUT /api/storm/settings': () => ({ status: 400, body: { error: 'Please enter a number of days between 1 and 30.', field: 'adDays' } }),
  });
  const { user } = renderStormTab();

  const days = await screen.findByLabelText(storm.settings.daysLabel);
  await user.clear(days);
  await user.type(days, '40');
  await user.click(saveButton());

  expect(await screen.findByText('Please enter a number of days between 1 and 30.')).toBeInTheDocument();
  expect(screen.getByLabelText(storm.settings.daysLabel)).toHaveAttribute('aria-invalid', 'true');
});

it('storm tab warns when the text message loses Reply STOP and blocks save', async () => {
  stubStorm();
  renderStormTab();

  const sms = await screen.findByLabelText(storm.settings.smsLabel);
  fireEvent.change(sms, { target: { value: 'Hi {first_name}, {company} here. Hail hit near {street}.' } });

  expect(await screen.findByText(storm.settings.missingTokens('Reply STOP'))).toBeInTheDocument();
  expect(saveButton()).toBeDisabled();
});

it('storm tab warns when the email loses the unsubscribe link', async () => {
  stubStorm();
  renderStormTab();

  const email = await screen.findByLabelText(storm.settings.emailLabel);
  fireEvent.change(email, { target: { value: 'Hi {first_name}, {company} at {company_address}.' } });

  expect(await screen.findByText(storm.settings.missingTokens('{unsubscribe}'))).toBeInTheDocument();
  expect(saveButton()).toBeDisabled();
});

it('storm tab resets a template to the standard text', async () => {
  stubStorm();
  const { user } = renderStormTab();

  await user.click(await screen.findByRole('button', { name: storm.settings.useStandardTextFor(storm.settings.smsLabel) }));
  expect(screen.getByLabelText(storm.settings.smsLabel)).toHaveValue(DEFAULT_SMS);

  await user.click(saveButton());
  await waitFor(() => expect(api.sent('PUT /api/storm/settings')).toEqual([{ smsTemplate: DEFAULT_SMS }]));
});

it('storm tab uploads a photo and lists it', async () => {
  stubStorm();
  renderStormTab();

  const file = new File(['jpeg-bytes'], 'roof.jpg', { type: 'image/jpeg' });
  fireEvent.change(await screen.findByLabelText(storm.settings.photoPickLabel), { target: { files: [file] } });

  expect(await screen.findByRole('img', { name: storm.settings.photoAlt(1) })).toHaveAttribute('src', '/api/storm/photos/p1/file');
  expect(uploads).toEqual([{ type: 'image/jpeg', body: file }]);
});

it('storm tab refuses a GIF or a file over 5 MB before sending', async () => {
  stubStorm();
  renderStormTab();

  const picker = await screen.findByLabelText(storm.settings.photoPickLabel);
  fireEvent.change(picker, { target: { files: [new File(['gif'], 'hail.gif', { type: 'image/gif' })] } });
  expect(await screen.findByText(storm.settings.photoType)).toBeInTheDocument();

  const big = new File([new Uint8Array(5 * MB + KB)], 'big.jpg', { type: 'image/jpeg' });
  fireEvent.change(picker, { target: { files: [big] } });
  expect(await screen.findByText(storm.settings.photoSize)).toBeInTheDocument();

  expect(uploads).toEqual([]);
});

it('storm tab shows the server message when an upload is refused', async () => {
  stubStorm();
  // A refusal from the server, not from our own checks: the upload is answered 413 here, everything else as before
  const delegate = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && String(input) === '/api/storm/photos') {
        return Promise.resolve(new Response(JSON.stringify({ error: 'That photo is too large to use.' }), { status: 413 }));
      }
      return delegate(input, init);
    }),
  );
  renderStormTab();

  fireEvent.change(await screen.findByLabelText(storm.settings.photoPickLabel), {
    target: { files: [new File(['x'], 'roof.png', { type: 'image/png' })] },
  });

  expect(await screen.findByText('That photo is too large to use.')).toBeInTheDocument();
});

it('storm tab removes a photo', async () => {
  server.photos = [photo('p1')];
  stubStorm();
  const { user } = renderStormTab();

  await user.click(await screen.findByRole('button', { name: storm.settings.removePhoto(1) }));

  await waitFor(() => expect(deletes).toEqual(['p1']));
  await waitFor(() => expect(screen.queryByRole('img', { name: storm.settings.photoAlt(1) })).not.toBeInTheDocument());
});

it('storm tab disables the picker at 5 photos', async () => {
  server.photos = ['p1', 'p2', 'p3', 'p4', 'p5'].map(photo);
  stubStorm();
  renderStormTab();

  expect(await screen.findByText(storm.settings.photosFull(5))).toBeInTheDocument();
  expect(screen.queryByLabelText(storm.settings.photoPickLabel)).not.toBeInTheDocument();
  expect(screen.getAllByRole('img')).toHaveLength(5);
});

it('storm tab shows the generic failure when the settings cannot be read', async () => {
  stubStorm({ 'GET /api/storm/settings': () => ({ status: 500, body: { error: 'Unexpected failure' } }) });
  renderStormTab();

  expect(await screen.findByText(errors.generic)).toBeInTheDocument();
});

it('storm tab shows no save bar until something changes, then Save and Discard', async () => {
  stubStorm();
  const { user } = renderStormTab();

  const budget = await screen.findByLabelText(storm.settings.budgetLabel);
  expect(saveBar()).toBeNull();
  expect(screen.queryByRole('button', { name: storm.settings.save })).toBeNull();

  await user.clear(budget);
  await user.type(budget, '300');
  expect(saveBar()).not.toBeNull();
  expect(saveButton()).toBeEnabled();

  await user.click(screen.getByRole('button', { name: settingsCopy.saveBar.discard }));
  expect(screen.getByLabelText(storm.settings.budgetLabel)).toHaveValue('250.00');
  expect(saveBar()).toBeNull();
  expect(api.count('PUT /api/storm/settings')).toBe(0);
});

it('storm tab keeps Discard for an entry that cannot be saved, and Save off', async () => {
  stubStorm();
  const { user } = renderStormTab();

  const budget = await screen.findByLabelText(storm.settings.budgetLabel);
  await user.clear(budget);
  await user.type(budget, 'lots');

  expect(await screen.findByText(storm.settings.budgetInvalid)).toBeInTheDocument();
  expect(saveButton()).toBeDisabled();
  await user.click(screen.getByRole('button', { name: settingsCopy.saveBar.discard }));
  expect(screen.getByLabelText(storm.settings.budgetLabel)).toHaveValue('250.00');
  expect(screen.queryByText(storm.settings.budgetInvalid)).toBeNull();
});

it('storm tab goes back to a clean form once the change is saved', async () => {
  stubStorm();
  const { user } = renderStormTab();

  await user.click(await screen.findByRole('switch', { name: storm.settings.emailsLabel }));
  await user.click(saveButton());

  await waitFor(() => expect(api.sent('PUT /api/storm/settings')).toEqual([{ emailEnabled: false }]));
  await waitFor(() => expect(saveBar()).toBeNull());
  expect(screen.getByRole('switch', { name: storm.settings.emailsLabel })).toHaveAttribute('aria-checked', 'false');
});

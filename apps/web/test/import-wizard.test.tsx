import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { consentAttestationText, type ImportView } from '@roofline/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import type { CompanyBody } from '../src/api/types.ts';
import { importCopy } from '../src/copy/import.ts';
import { ACCOUNT, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

// The real map loads maplibre-gl, which these tests never need.
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return {
    MapView: () => createElement('div', { 'data-map-mock': true }),
  };
});

const COMPANY: CompanyBody = {
  id: 'c1',
  name: 'Acme Roofing',
  slug: 'acme-roofing',
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
};

function importView(overrides: Partial<ImportView> = {}): ImportView {
  return {
    id: 'i1',
    fileName: 'c.csv',
    status: 'uploaded',
    headers: ['Name', 'Phone'],
    mapping: { name: 0, phone: 1 },
    rowCount: 3,
    counts: {
      total: 3,
      new: 2,
      updated: 1,
      skipped: 0,
      skippedBy: { noName: 0, noContact: 0, badPhone: 0, duplicate: 0 },
      consent: { attested: 0, express: 0, unchanged: 0, optedOutKept: 0 },
      jobs: 0,
      processed: 0,
      located: 0,
      notLocated: 0,
    },
    preview: [
      { row: 1, outcome: 'create', reason: null, name: 'Ann Lee', phone: '+14025550101', email: null, address: null, stage: null, consent: 'express' },
      { row: 2, outcome: 'update', reason: null, name: 'Ben Cruz', phone: '+14025550102', email: null, address: null, stage: null, consent: 'express' },
    ],
    progress: { processed: 0, total: 3 },
    consentAttested: false,
    startedAt: null,
    finishedAt: null,
    errorPlain: null,
    skippedDownloadUrl: null,
    ...overrides,
  };
}

let api: ReturnType<typeof stubApi>;
/** The import as the server holds it now: the stub answers from it, and a start moves it on. */
let current: ImportView;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A signed-in owner, whose import i1 is `view` until the stub changes it. */
function setup(view: ImportView) {
  current = view;
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/company': () => ({ body: COMPANY }),
    'POST /api/imports?fileName=c.csv': () => {
      current = importView();
      return { status: 201, body: current };
    },
    'GET /api/imports/i1?attested=false': () => ({ body: current }),
    'GET /api/imports/i1?attested=true': () => ({ body: current }),
    'PATCH /api/imports/i1': () => ({ body: current }),
    'POST /api/imports/i1/start': ({ body }) => {
      const attested = (body as { consentAttested: boolean }).consentAttested;
      current = importView({ status: 'queued', consentAttested: attested });
      return { status: 202, body: current };
    },
  });
  return api;
}

function renderApp(path: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: [path] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, user: userEvent.setup() };
}

/** Moves from the mapping step through the preview to the consent step. */
async function reachConsent(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: importCopy.next }));
  await waitFor(() => expect(screen.queryByText(importCopy.mappingTitle)).not.toBeInTheDocument());
  await user.click(await screen.findByRole('button', { name: importCopy.next }));
  await screen.findByRole('button', { name: importCopy.startImport });
}

it('uploads, maps, previews and imports', async () => {
  setup(importView({ status: 'uploaded' }));
  const { router, user } = renderApp('/settings/setup/import');

  const input = await screen.findByLabelText(importCopy.uploadLabel);
  await user.upload(input, new File(['Name,Phone\n'], 'c.csv', { type: 'text/csv' }));
  await waitFor(() => expect(where(router)).toBe('/settings/setup/import/i1'));

  await reachConsent(user);
  expect(api.sent('PATCH /api/imports/i1')).toEqual([{ mapping: { name: 0, phone: 1 } }]);

  await user.click(screen.getByRole('button', { name: importCopy.startImport }));
  await screen.findByRole('progressbar');
  expect(api.sent('POST /api/imports/i1/start')).toEqual([{ consentAttested: false }]);

  const uploadCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).startsWith('/api/imports?'));
  expect(uploadCall).toBeDefined();
  expect((uploadCall![1]?.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
}, 15000);

it('the consent box is unchecked and sends the exact text when checked', async () => {
  setup(importView({ status: 'uploaded' }));
  const { user } = renderApp('/settings/setup/import/i1');

  await reachConsent(user);
  const box = await screen.findByRole('checkbox', { name: consentAttestationText('Acme Roofing') });
  expect(box).not.toBeChecked();
  await user.click(box);
  expect(box).toBeChecked();

  await user.click(screen.getByRole('button', { name: importCopy.startImport }));
  await screen.findByRole('progressbar');
  expect(api.sent('POST /api/imports/i1/start')).toEqual([
    { consentAttested: true, consentText: consentAttestationText('Acme Roofing') },
  ]);
}, 15000);

it('shows how many opted-out customers stay off', async () => {
  setup(
    importView({
      status: 'uploaded',
      counts: { ...importView().counts, consent: { attested: 0, express: 0, unchanged: 0, optedOutKept: 12 } },
    }),
  );
  const { user } = renderApp('/settings/setup/import/i1');

  await reachConsent(user);
  expect(await screen.findByText('12 customers previously opted out, and their texting stays off')).toBeInTheDocument();
}, 15000);

it('shows progress, then the summary with the download link', async () => {
  setup(importView({ status: 'processing', progress: { processed: 1, total: 3 } }));
  renderApp('/settings/setup/import/i1');

  expect(await screen.findByRole('progressbar')).toBeInTheDocument();

  current = importView({
    status: 'done',
    progress: { processed: 3, total: 3 },
    finishedAt: '2026-10-12T10:00:00.000Z',
    skippedDownloadUrl: '/api/imports/i1/skipped.csv',
  });
  // The page polls every 2 seconds while the import runs.
  const link = await screen.findByRole('link', { name: importCopy.downloadSkipped }, { timeout: 3000 });
  expect(link).toHaveAttribute('download');
  expect(link).toHaveAttribute('href', '/api/imports/i1/skipped.csv');
}, 15000);

it('a double click starts one import', async () => {
  setup(importView({ status: 'uploaded' }));
  // The start answer comes back slowly, so a second click would land while the first is in flight.
  const inner = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/start')) {
      return new Promise<Response>((resolve) => setTimeout(() => resolve(inner(input, init)), 300));
    }
    return inner(input, init);
  });
  const { user } = renderApp('/settings/setup/import/i1');

  await reachConsent(user);
  await user.dblClick(screen.getByRole('button', { name: importCopy.startImport }));
  await screen.findByRole('progressbar');
  expect(api.count('POST /api/imports/i1/start')).toBe(1);
}, 15000);

it('the preview says why a row will be skipped', async () => {
  const base = importView();
  setup(
    importView({
      status: 'uploaded',
      preview: [
        ...base.preview,
        { row: 3, outcome: 'skip', reason: 'No phone and no email', name: null, phone: null, email: null, address: null, stage: null, consent: 'express' },
      ],
    }),
  );
  const { user } = renderApp('/settings/setup/import/i1');

  await user.click(await screen.findByRole('button', { name: importCopy.next }));
  await screen.findByRole('heading', { name: importCopy.previewTitle });
  const table = screen.getByRole('table', { name: importCopy.previewTableLabel });
  expect(within(table).getByText(`${importCopy.outcomeSkip}: No phone and no email`)).toBeInTheDocument();
}, 15000);

it('shows the server message for a bad file', async () => {
  setup(importView({ status: 'uploaded' }));
  api.routes['POST /api/imports?fileName=c.csv'] = () => ({
    status: 400,
    body: { error: 'Please upload a .csv or .xlsx file.', field: 'file' },
  });
  const { router, user } = renderApp('/settings/setup/import');

  const input = await screen.findByLabelText(importCopy.uploadLabel);
  await user.upload(input, new File(['x'], 'c.csv', { type: 'text/csv' }));

  expect(await screen.findByText('Please upload a .csv or .xlsx file.')).toBeInTheDocument();
  expect(where(router)).toBe('/settings/setup/import');
}, 15000);

it('a failed mapping save shows the server message and stays on the mapping step', async () => {
  setup(importView({ status: 'uploaded' }));
  api.routes['PATCH /api/imports/i1'] = () => ({
    status: 500,
    body: { error: 'Something broke on our side.' },
  });
  const { user } = renderApp('/settings/setup/import/i1');

  await user.click(await screen.findByRole('button', { name: importCopy.next }));
  // An always-mounted empty alert region sits on the page too, so find the alert by its words.
  const alert = await screen.findByText('Something broke on our side.');
  expect(alert).toHaveAttribute('role', 'alert');
  expect(screen.getByText(importCopy.mappingTitle)).toBeInTheDocument();
  expect(screen.queryByText(importCopy.previewTitle)).not.toBeInTheDocument();
}, 15000);

it('a failed retry shows the server message', async () => {
  setup(importView({ status: 'failed', errorPlain: 'The file could not be read.' }));
  api.routes['POST /api/imports/i1/retry'] = () => ({
    status: 500,
    body: { error: 'Could not restart.' },
  });
  const { user } = renderApp('/settings/setup/import/i1');

  await user.click(await screen.findByRole('button', { name: importCopy.tryAgain }));
  // The always-mounted empty alert region sits on the page too, so find the alert by its words.
  const alert = await screen.findByText('Could not restart.');
  expect(alert).toHaveAttribute('role', 'alert');
}, 15000);

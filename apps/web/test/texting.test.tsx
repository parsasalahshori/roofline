import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { USE_CASE_LABEL, type BrandInfo, type TextingView } from '@roofline/shared';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { texting } from '../src/copy/texting.ts';
import { ACCOUNT, SHELL_ROUTES, stubApi } from './helpers.tsx';

// The real map loads maplibre-gl, which these tests never need. The stand-in has two pins that open a job and a customer.
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return {
    MapView: (props: { onOpen: (target: { kind: 'customer' | 'job'; id: string }) => void }) =>
      createElement(
        'div',
        { 'data-map-mock': true },
        createElement('button', { type: 'button', onClick: () => props.onOpen({ kind: 'job', id: 'j9' }) }, 'job pin'),
        createElement('button', { type: 'button', onClick: () => props.onOpen({ kind: 'customer', id: 'c9' }) }, 'customer pin'),
      ),
  };
});

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A complete, valid brand as the company has it. */
const FULL_BRAND: BrandInfo = {
  legalName: 'Summit Roofing LLC',
  ein: '12-3456789',
  businessType: 'llc',
  street: '12 Main St',
  city: 'Omaha',
  state: 'NE',
  zip: '68102',
  website: 'https://summit.example.test',
  contactFirstName: 'Sam',
  contactLastName: 'Roofer',
  contactEmail: 'sam@summit.example.test',
  contactPhone: '+14025550100',
  contactTitle: 'Owner',
};

/** A texting view with the defaults for a company that has not started. Pass what differs. */
function view(overrides: Partial<TextingView> = {}): TextingView {
  return {
    state: 'not_started',
    reason: null,
    rejectedFields: [],
    brand: null,
    defaults: { legalName: 'Summit Roofing LLC', website: '' },
    submittedAt: null,
    approvedAt: null,
    number: null,
    needsPaymentMethod: false,
    needsVerifiedEmail: false,
    hostedPolicyUrls: { privacy: 'https://summit.example.test/privacy', terms: 'https://summit.example.test/terms' },
    ...overrides,
  };
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
  return { router, queryClient, user: userEvent.setup() };
}

/** A signed-in owner, with the shell's reads answered as "nothing", and the texting view answered as `current`. */
function signedInApi(current: TextingView, registration?: { status?: number; body: unknown }) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/texting': () => ({ body: current }),
    'POST /api/texting/registration': () => ({
      status: registration?.status ?? 202,
      body: registration?.body ?? view({ state: 'waiting', submittedAt: '2026-10-11T15:00:00Z' }),
    }),
  });
  return api;
}

const REGISTRATION = 'POST /api/texting/registration';

describe('texting registration', () => {
  it('prefills from the company and submits', async () => {
    signedInApi(view());
    const { user } = renderApp('/settings/setup/texting');

    const legalName = await screen.findByLabelText(texting.fields.legalName);
    expect(legalName).toHaveValue('Summit Roofing LLC');
    expect(screen.getByLabelText(texting.fields.website)).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: texting.useHostedPages })).toBeChecked();
    expect(screen.getByText(texting.whatYouText(USE_CASE_LABEL))).toBeInTheDocument();

    await user.type(screen.getByLabelText(texting.fields.ein), '12-3456789');
    await user.selectOptions(screen.getByLabelText(texting.fields.businessType), 'llc');
    await user.type(screen.getByLabelText(texting.fields.street), '12 Main St');
    await user.type(screen.getByLabelText(texting.fields.city), 'Omaha');
    await user.type(screen.getByLabelText(texting.fields.state), 'NE');
    await user.type(screen.getByLabelText(texting.fields.zip), '68102');
    await user.type(screen.getByLabelText(texting.fields.contactFirstName), 'Sam');
    await user.type(screen.getByLabelText(texting.fields.contactLastName), 'Roofer');
    await user.type(screen.getByLabelText(texting.fields.contactEmail), 'sam@summit.example.test');
    await user.type(screen.getByLabelText(texting.fields.contactPhone), '4025550100');
    await user.type(screen.getByLabelText(texting.fields.contactTitle), 'Owner');
    await user.click(screen.getByRole('button', { name: texting.send }));

    await screen.findByText(texting.waiting);
    expect(api.sent(REGISTRATION)).toEqual([
      {
        brand: {
          legalName: 'Summit Roofing LLC',
          ein: '12-3456789',
          businessType: 'llc',
          street: '12 Main St',
          city: 'Omaha',
          state: 'NE',
          zip: '68102',
          website: '',
          contactFirstName: 'Sam',
          contactLastName: 'Roofer',
          contactEmail: 'sam@summit.example.test',
          contactPhone: '4025550100',
          contactTitle: 'Owner',
        },
        useHostedPolicyPages: true,
      },
    ]);
  });

  it('needs a card first', async () => {
    signedInApi(view({ needsPaymentMethod: true }));
    renderApp('/settings/setup/texting');

    expect(await screen.findByText(texting.needsCard)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: texting.send })).toBeDisabled();
    expect(screen.getByRole('link', { name: texting.addCard })).toHaveAttribute('href', '/settings/billing');
  });

  it('shows the reason and highlights fields on a rejection', async () => {
    signedInApi(
      view({
        state: 'needs_fix',
        reason: 'The EIN did not match the legal name.',
        rejectedFields: ['legalName', 'ein'],
        brand: FULL_BRAND,
      }),
    );
    renderApp('/settings/setup/texting');

    expect(await screen.findByText('The EIN did not match the legal name.')).toBeInTheDocument();
    expect(screen.getAllByText(texting.checkThis)).toHaveLength(2);
    expect(screen.getByLabelText(texting.fields.legalName)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(texting.fields.legalName)).toHaveAccessibleDescription(texting.checkThis);
    expect(screen.getByLabelText(texting.fields.ein)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(texting.fields.ein)).toHaveAccessibleDescription(texting.checkThis);
    expect(screen.getByRole('button', { name: texting.fixAndResubmit })).toBeInTheDocument();
  });

  it('shows waiting after submit', async () => {
    signedInApi(view({ defaults: FULL_BRAND }));
    const { user } = renderApp('/settings/setup/texting');

    await user.click(await screen.findByRole('button', { name: texting.send }));

    expect(await screen.findByText(texting.waiting)).toBeInTheDocument();
    expect(screen.getByText(texting.submittedOn('Oct 11'))).toBeInTheDocument();
  });

  it('shows the number once approved', async () => {
    signedInApi(
      view({
        state: 'approved',
        brand: FULL_BRAND,
        approvedAt: '2026-10-11T15:00:00Z',
        number: '+14025550100',
      }),
    );
    renderApp('/settings/setup/texting');

    expect(await screen.findByText('Texting is on. Your number is (402) 555-0100.')).toBeInTheDocument();
  });

  it('shows approved without a number yet', async () => {
    signedInApi(
      view({
        state: 'approved',
        brand: FULL_BRAND,
        approvedAt: '2026-10-11T15:00:00Z',
        number: null,
      }),
    );
    renderApp('/settings/setup/texting');

    expect(await screen.findByText("You're approved. We're getting your texting number ready.")).toBeInTheDocument();
  });

  it('a server field error lands under its field', async () => {
    signedInApi(view({ defaults: FULL_BRAND }), {
      status: 400,
      body: { error: 'Enter your 9-digit EIN.', field: 'brand.ein' },
    });
    const { user } = renderApp('/settings/setup/texting');

    await user.click(await screen.findByRole('button', { name: texting.send }));

    const ein = await screen.findByLabelText(texting.fields.ein);
    expect(await screen.findByText('Enter your 9-digit EIN.')).toBeInTheDocument();
    expect(ein).toHaveAttribute('aria-invalid', 'true');
    expect(ein).toHaveAccessibleDescription('Enter your 9-digit EIN.');
    expect(within(ein.closest('div') as HTMLElement).getByText('Enter your 9-digit EIN.')).toBeInTheDocument();
  });
});

import { DEFAULT_TIER_TEMPLATES, defaultPricebook, priceTier } from '@roofline/shared';
import type { CompanyBody } from '../src/api/types.ts';
import type { PricebookView, ProposalOptionView, ProposalStatus, ProposalView, Tier } from '@roofline/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { proposals } from '../src/copy/proposals.ts';
import { ACCOUNT, type Routes, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

// The real map loads maplibre-gl, which these tests never need.
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

const BASE = { areaSqFt: 2480, areaType: 'surface' as const, pitch: 6, stories: 1, layers: 1, ridgeFt: 40, edgeFt: 120, valleyFt: 20, deckingSheets: 0, taxPercent: 0, markupPercent: 25 };
const QUANTITIES = { squares: 24.8, edgeFt: 120, ridgeFt: 40, valleyFt: 20 };
const TIERS: Tier[] = ['good', 'better', 'best'];

const COMPANY: CompanyBody = {
  id: 'c1', name: 'Summit Roofing', slug: 'summit-roofing', status: 'active', legalName: null, phone: null, email: null, website: null,
  addressStreet: null, addressCity: null, addressState: null, addressZip: null, timezone: 'America/Chicago', logoUrl: null, located: false, serviceAreaMiles: null,
};

/** The total the price book gives option `index`, with optional changes to its template. */
function priced(index: number, over: { wastePercent?: number } = {}) {
  const template = { ...DEFAULT_TIER_TEMPLATES[index]!, ...over };
  return { template, result: priceTier(template, BASE, defaultPricebook, QUANTITIES) };
}

function makeOption(index: number, over: { wastePercent?: number; enabled?: boolean } = {}): ProposalOptionView {
  const { template, result } = priced(index, over);
  return {
    id: `o${index + 1}`, tier: TIERS[index]!, name: template.name, highlights: template.highlights, scope: result.scope, addOns: template.addOns,
    calculation: result.calculation, addOnLines: result.addOnLines, totalCents: result.totalCents, monthlyEstimateCents: null, enabled: over.enabled ?? true,
  };
}

function makeProposal(over: Partial<ProposalView> = {}): ProposalView {
  return {
    id: 'p1', number: 'P-0001', status: 'draft' as ProposalStatus, jobId: 'j1', customer: { id: 'cu1', name: 'Maria Lopez', phone: null },
    address: '12 Oak St', measurementId: 'm1', basis: 'exact', options: [0, 1, 2].map((i) => makeOption(i)), messageBody: '', validUntil: '2026-11-12',
    sentAt: null, views: { count: 0, first: null, last: null }, signed: null, declined: null, taskId: null, replacedById: null, canEdit: true,
    ...over,
  };
}

const PRICEBOOK: PricebookView = {
  prices: defaultPricebook,
  defaults: { wastePercent: 10, markupPercent: 25, taxPercent: 0, material: 'architectural' },
  isExample: false,
};

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

function open(proposal: ProposalView, own: Routes = {}) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/company': () => ({ body: COMPANY }),
    'GET /api/pricebook': () => ({ body: PRICEBOOK }),
    [`GET /api/proposals/${proposal.id}`]: () => ({ body: proposal }),
    ...own,
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: [`/estimator/proposals/${proposal.id}`] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, user: userEvent.setup() };
}

const card = (tier: Tier) => screen.findByRole('region', { name: proposals.optionHeading(tier) });

describe('proposal window', () => {
  it('live totals equal priceTier', async () => {
    const { user } = open(makeProposal(), {
      'PATCH /api/proposals/p1': () => ({ body: makeProposal({ options: [makeOption(0, { wastePercent: 15 }), makeOption(1), makeOption(2)] }) }),
    });

    for (const [index, tier] of TIERS.entries()) {
      const total = proposals.money(priced(index).result.totalCents);
      expect(within(await card(tier)).getAllByText(total).length).toBeGreaterThan(0);
    }

    const first = await card('good');
    const waste = within(first).getByLabelText(proposals.fieldWaste);
    await user.clear(waste);
    await user.type(waste, '15');
    await user.tab();

    const edited = proposals.money(priced(0, { wastePercent: 15 }).result.totalCents);
    expect(within(await card('good')).getAllByText(edited).length).toBeGreaterThan(0);
    await waitFor(() => expect(api.count('PATCH /api/proposals/p1')).toBe(1));
    expect(api.unexpected).toEqual([]);
  });

  it('a failed save puts the option back', async () => {
    const { user } = open(makeProposal(), { 'PATCH /api/proposals/p1': () => ({ status: 500, body: { error: 'nope' } }) });

    const waste = within(await card('good')).getByLabelText(proposals.fieldWaste);
    await user.clear(waste);
    await user.type(waste, '15');
    await user.tab();
    await waitFor(() => expect(api.count('PATCH /api/proposals/p1')).toBe(1));

    await waitFor(async () => {
      const first = await card('good');
      expect((within(first).getByLabelText(proposals.fieldWaste) as HTMLInputElement).value).toBe(String(priced(0).result.scope.wastePercent));
      expect(within(first).getAllByText(proposals.money(priced(0).result.totalCents)).length).toBeGreaterThan(0);
      expect(within(first).queryAllByText(proposals.money(priced(0, { wastePercent: 15 }).result.totalCents))).toHaveLength(0);
    });
  });

  it('editing PATCHes', async () => {
    const { user } = open(makeProposal(), {
      'PATCH /api/proposals/p1': ({ body }) => {
        const first = (body as { options: { enabled?: boolean; wastePercent?: number }[] }).options[0]!;
        return {
          body: makeProposal({
            options: [makeOption(0, { wastePercent: first.wastePercent ?? 10, enabled: first.enabled ?? true }), makeOption(1), makeOption(2)],
          }),
        };
      },
    });

    const waste = within(await card('good')).getByLabelText(proposals.fieldWaste);
    await user.clear(waste);
    await user.type(waste, '15');
    await user.tab();
    await waitFor(() => expect(api.sent('PATCH /api/proposals/p1')).toEqual([{ options: [{ id: 'o1', wastePercent: 15 }] }]));

    await user.click(within(await card('good')).getByRole('switch', { name: proposals.optionOn }));
    await waitFor(() => expect(api.count('PATCH /api/proposals/p1')).toBe(2));
    expect(api.sent('PATCH /api/proposals/p1')[1]).toEqual({ options: [{ id: 'o1', enabled: false }] });
    expect(api.unexpected).toEqual([]);
  });

  it('a sent proposal is read-only with Make a revised proposal', async () => {
    const { router, user } = open(makeProposal({ status: 'sent', sentAt: '2026-10-11T15:00:00.000Z' }), {
      'POST /api/proposals/p1/revise': () => ({ body: makeProposal({ id: 'p2', number: 'P-0002' }) }),
      'GET /api/proposals/p2': () => ({ body: makeProposal({ id: 'p2', number: 'P-0002' }) }),
    });

    expect(await screen.findByText(proposals.readOnlyNote)).toBeInTheDocument();
    for (const tier of TIERS) {
      const options = await card(tier);
      expect(within(options).queryAllByRole('textbox')).toEqual([]);
      expect(within(options).queryAllByRole('spinbutton')).toEqual([]);
      expect(within(options).queryAllByRole('switch')).toEqual([]);
    }

    await user.click(screen.getByRole('button', { name: proposals.makeRevised }));
    await waitFor(() => expect(where(router)).toBe('/estimator/proposals/p2'));
    expect(api.count('POST /api/proposals/p1/revise')).toBe(1);
    expect(await screen.findByText(proposals.title('P-0002'))).toBeInTheDocument();
    expect(api.unexpected).toEqual([]);
  });

  it('events line', async () => {
    // 7:12 PM in Chicago on 11 October (UTC-5); "now" is later that same Chicago day.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-12T03:00:00.000Z') });
    open(makeProposal({ status: 'viewed', sentAt: '2026-10-10T15:00:00.000Z', views: { count: 3, first: '2026-10-10T16:00:00.000Z', last: '2026-10-12T00:12:00.000Z' } }));

    expect(await screen.findByText('Opened 3 times · last today 7:12 PM')).toBeInTheDocument();
    expect(api.unexpected).toEqual([]);
  });

  it('copy link writes the clipboard and toasts', async () => {
    const { user } = open(makeProposal({ status: 'sent', sentAt: '2026-10-11T15:00:00.000Z' }), {
      'GET /api/proposals/p1/link': () => ({ body: { url: 'https://app.example.com/p/abc' } }),
    });
    // userEvent.setup() installs its own clipboard, so the stand-in goes on afterwards.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    await user.click(await screen.findByRole('button', { name: proposals.copyLink }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://app.example.com/p/abc'));
    expect(await screen.findByText(proposals.linkCopied, { selector: '[role="status"], [role="alert"], [role="status"] *, [role="alert"] *' })).toBeInTheDocument();
    expect(api.unexpected).toEqual([]);
  });

  it('a rep without price book access sees saved totals', async () => {
    open(makeProposal(), { 'GET /api/pricebook': () => ({ status: 403, body: { error: 'Not allowed.' } }) });

    for (const [index, tier] of TIERS.entries()) {
      expect(within(await card(tier)).getAllByText(proposals.money(makeOption(index).totalCents)).length).toBeGreaterThan(0);
    }
    await waitFor(() => expect(api.count('GET /api/pricebook')).toBe(1));
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
    expect(screen.queryByText(proposals.saveFailed)).toBeNull();
    expect(api.unexpected).toEqual([]);
  });
});

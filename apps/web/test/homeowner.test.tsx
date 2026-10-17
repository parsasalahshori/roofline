import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_TEXT_V1, ESTIMATE_CLAUSE_V1, type PublicProposalView } from '@roofline/shared';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { homeowner, money } from '../src/copy/homeowner.ts';
import { publicCopy } from '../src/copy/public.ts';
import { quote } from '../src/copy/quote.ts';
import { SIGNED_PDF_POLL_LIMIT, SIGNED_PDF_POLL_MS, signedPdfUrl } from '../src/features/homeowner/api.ts';
import { type Reply, stubApi } from './helpers.tsx';

/*
 * The public proposal page at /p/:token: no session, no shell. The public API is not built yet,
 * so fetch is stubbed with the endpoint shapes of the brief.
 */

const TOKEN = 'tok123';
const PROPOSAL_URL = `/api/public/proposals/${TOKEN}`;
const GET_KEY = `GET ${PROPOSAL_URL}`;
const VIEW_KEY = `POST ${PROPOSAL_URL}/view`;
const SIGN_KEY = `POST ${PROPOSAL_URL}/sign`;
const DECLINE_KEY = `POST ${PROPOSAL_URL}/decline`;

const MIDDLE_ID = 'opt-better';

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(api?.unexpected ?? []).toEqual([]);
});

/** An open proposal from Acme Roofing for Maria. The middle option is the one most people pick. */
function fixture(overrides: Partial<PublicProposalView> = {}): PublicProposalView {
  return {
    companyName: 'Acme Roofing',
    companyPhone: '+15555550100',
    accentColor: null,
    logoUrl: null,
    firstName: 'Maria',
    address: '12 Oak Lane, Springfield',
    validUntil: '2026-11-30',
    status: 'open',
    basis: 'estimate',
    options: [
      {
        id: 'opt-good',
        tier: 'good',
        name: 'Good',
        highlights: ['Architectural shingles'],
        inclusions: ['Tear-off of the old roof'],
        totalCents: 990000,
        monthlyEstimateCents: null,
        financingTerms: null,
      },
      {
        id: MIDDLE_ID,
        tier: 'better',
        name: 'Better',
        highlights: ['Upgraded underlayment'],
        inclusions: ['Ridge vent', 'Drip edge'],
        totalCents: 1425000,
        monthlyEstimateCents: 21500,
        financingTerms: { aprBps: 899, months: 120 },
      },
      {
        id: 'opt-best',
        tier: 'best',
        name: 'Best',
        highlights: ['Lifetime warranty'],
        inclusions: ['Gutter guards'],
        totalCents: 1890000,
        monthlyEstimateCents: 28500,
        financingTerms: { aprBps: 899, months: 120 },
      },
    ],
    signed: null,
    estimateClause: true,
    ...overrides,
  };
}

/**
 * Answers the page's requests. `read` is asked on every GET, so a test can change the proposal
 * between reads. A signed-out person's session check answers 401, as it does for every visitor.
 */
function proposalApi(read: () => Reply) {
  api = stubApi({
    'GET /api/auth/me': () => ({ status: 401, body: { error: 'Sign in first.' } }),
    [GET_KEY]: read,
    [VIEW_KEY]: () => ({ body: {} }),
    [SIGN_KEY]: () => ({ body: { signed: true } }),
    [DECLINE_KEY]: () => ({ body: {} }),
  });
  return api;
}

function renderPage(path = `/p/${TOKEN}`) {
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

/** The main button for a tier and its total: "Choose Better · $14,250". Better is the tile that is picked when the page opens. */
const choose = (tier: 'Good' | 'Better' | 'Best' = 'Better', cents = 1425000) => homeowner.chooseOption(tier, money(cents));
const chooseButton = (tier?: 'Good' | 'Better' | 'Best', cents?: number) => screen.getByRole('button', { name: choose(tier, cents) });

/** Presses Tab until `target()` has focus. Keyboard only: no click and no focus() call. */
async function tabTo(user: UserEvent, target: () => HTMLElement, limit = 40): Promise<void> {
  for (let step = 0; step < limit; step += 1) {
    if (document.activeElement === target()) return;
    await user.tab();
  }
  throw new Error('Could not tab to the wanted control.');
}

describe('the company on the proposal page', () => {
  const brandStyle = () => document.getElementById('roofline-brand');
  /** The proposal as the API may one day send it: the same view, plus the company's logo, colour and roof facts. */
  const withExtras = (extra: Record<string, unknown>): PublicProposalView => ({ ...fixture(), ...extra }) as PublicProposalView;

  afterEach(() => {
    brandStyle()?.remove();
  });

  it("a colour in the payload goes in through applyBrand and leaves with the page; with none, the default stays", async () => {
    proposalApi(() => ({ body: withExtras({ accentColor: '#ed3a2b' }) }));
    const view = renderPage();
    await screen.findAllByTestId('option-card');
    await waitFor(() => expect(brandStyle()).not.toBeNull());
    expect(brandStyle()!.textContent).toMatch(/--brand:\s*#[0-9a-f]{6}/i);
    cleanup();
    expect(brandStyle()).toBeNull();
    view.queryClient.clear();

    proposalApi(() => ({ body: fixture() }));
    renderPage();
    await screen.findAllByTestId('option-card');
    expect(brandStyle()).toBeNull();
  });

  it("the brand colour is set on the document root, so the sign sheet (portaled to the body, outside the page) wears it too", async () => {
    proposalApi(() => ({ body: withExtras({ accentColor: '#ed3a2b' }) }));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: choose() }));
    const sheet = await screen.findByRole('dialog', { name: homeowner.signTitle });
    await waitFor(() => expect(brandStyle()).not.toBeNull());
    // The style element holds the variables for the whole document, and the sheet is inside the document
    expect(brandStyle()!.textContent).toMatch(/:root|html/);
    expect(document.body.contains(sheet)).toBe(true);
    expect(sheet.closest('[class*="page"]')).toBeNull();
  });

  it('the company name is the wordmark, a logo image replaces it, and the Call pill dials the company', async () => {
    proposalApi(() => ({ body: fixture() }));
    renderPage();
    await screen.findAllByTestId('option-card');
    expect(screen.getByText('Acme Roofing')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: publicCopy.callAria('(555) 555-0100') })).toHaveAttribute('href', 'tel:+15555550100');
    cleanup();

    proposalApi(() => ({ body: withExtras({ logoUrl: 'https://cdn.example.test/acme.png' }) }));
    renderPage();
    expect(await screen.findByRole('img', { name: 'Acme Roofing' })).toHaveAttribute('src', 'https://cdn.example.test/acme.png');
    expect(screen.queryByText('Acme Roofing')).toBeNull();
  });

  it('the roof card shows the facts the company has, and nothing when it has none', async () => {
    proposalApi(() => ({ body: withExtras({ roof: { squares: 33.1, pitchX12: 6, hailInches: 1.25, photoCount: 18 } }) }));
    renderPage();
    const card = await screen.findByRole('region', { name: homeowner.roofFacts });
    expect(within(card).getByText(homeowner.squares(33.1))).toBeInTheDocument();
    expect(within(card).getByText(homeowner.pitch(6))).toBeInTheDocument();
    expect(within(card).getByText(homeowner.hail(1.25))).toBeInTheDocument();
    expect(within(card).getByText(homeowner.photos(18))).toBeInTheDocument();
    // No outline sent, so no picture of the home
    expect(within(card).queryByRole('img')).toBeNull();
    cleanup();

    // One fact: just that one. No dashes or zeros stand in for the rest.
    proposalApi(() => ({ body: withExtras({ roof: { squares: 28 } }) }));
    renderPage();
    const partial = await screen.findByRole('region', { name: homeowner.roofFacts });
    expect(within(partial).getByText(homeowner.squares(28))).toBeInTheDocument();
    expect(within(partial).queryByText(homeowner.pitchLabel)).toBeNull();
    expect(within(partial).queryByText(homeowner.hailLabel)).toBeNull();
    expect(partial.textContent ?? '').not.toMatch(/photo/);
    cleanup();

    // What the API sends today: no roof at all. No card.
    proposalApi(() => ({ body: fixture() }));
    renderPage();
    await screen.findAllByTestId('option-card');
    expect(screen.queryByRole('region', { name: homeowner.roofFacts })).toBeNull();
    cleanup();

    // Facts that are not usable numbers: no card either
    proposalApi(() => ({ body: withExtras({ roof: { squares: 0, pitchX12: null, hailInches: -1, photoCount: 0 } }) }));
    renderPage();
    await screen.findAllByTestId('option-card');
    expect(screen.queryByRole('region', { name: homeowner.roofFacts })).toBeNull();
  });

  it('the roof card shows the home from above when the company sent its outline', async () => {
    const ring: [number, number][] = [
      [-96.0002, 41.2499],
      [-95.9998, 41.2499],
      [-95.9998, 41.2501],
      [-96.0002, 41.2501],
    ];
    proposalApi(() => ({ body: withExtras({ roof: { squares: 30, outline: { center: [-96, 41.25], ring } } }) }));
    renderPage();
    const card = await screen.findByRole('region', { name: homeowner.roofFacts });
    expect(within(card).getByRole('img', { name: quote.outlineAlt })).toBeInTheDocument();
  });

  it('a signed proposal shows what was signed, a short timeline with only what is known, and the copy to keep', async () => {
    proposalApi(() => ({
      body: fixture({ status: 'signed', signed: { optionId: MIDDLE_ID, name: 'Maria Lopez', at: '2026-10-12T15:00:00.000Z', pdfReady: true } }),
    }));
    renderPage();
    expect(await screen.findByRole('heading', { name: homeowner.signedTitle })).toBeInTheDocument();
    expect(screen.getByText(homeowner.signedBy('Maria Lopez', 'Better'))).toBeInTheDocument();
    // The record: the roof and its tier, the day (said here once, not in the sentence above), the address and the total
    expect(screen.getByText(homeowner.optionKicker('Better'))).toBeInTheDocument();
    expect(screen.getAllByText(/Oct 12, 2026/)).toHaveLength(1);
    expect(screen.getByText(homeowner.signedOn('Oct 12, 2026'))).toBeInTheDocument();
    expect(screen.getByText('12 Oak Lane, Springfield')).toBeInTheDocument();
    expect(screen.getByText(money(1425000))).toBeInTheDocument();
    // The timeline has the two steps it knows, and invents no dates or crews
    expect(screen.getByText(homeowner.signedStepDone)).toBeInTheDocument();
    expect(screen.getByText(homeowner.signedStepCopy)).toBeInTheDocument();
    expect(screen.getByText(homeowner.signedStepNextBody('Acme Roofing'))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: homeowner.downloadPdf })).toBeInTheDocument();
  });
});

describe('the homeowner page', () => {
  it('renders the three tiles and the picked option as one all-in price', async () => {
    proposalApi(() => ({ body: fixture() }));
    const { user } = renderPage();

    const tiles = await screen.findAllByRole('radio');
    expect(tiles).toHaveLength(3);
    // Each tile says its tier and its total; Better is picked when the page opens.
    for (const [index, option] of fixture().options.entries()) {
      expect(tiles[index]).toHaveAccessibleName(new RegExp(`^${homeowner.tierLabel[option.tier]} ${money(option.totalCents).replace('$', '\\$')}`));
    }
    expect(tiles[1]).toBeChecked();
    expect(screen.getAllByText(homeowner.mostPopular)).toHaveLength(1);

    // One panel, for the picked option, with its one price and its button; the other options' prices are only on their tiles.
    const panels = screen.getAllByTestId('option-card');
    expect(panels).toHaveLength(1);
    expect(panels[0]).toHaveAccessibleName('Better');
    expect(within(panels[0]!).getByText(money(1425000))).toBeInTheDocument();
    expect(within(panels[0]!).getByText(homeowner.allIn)).toBeInTheDocument();
    expect(within(panels[0]!).getByText('Upgraded underlayment')).toBeInTheDocument();
    expect(within(panels[0]!).getByText('Ridge vent')).toBeInTheDocument();
    expect(chooseButton()).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/per square|per sq|\/sq\b/i);

    // Picking another tile swaps the panel and the button; nothing is chosen until the button is pressed.
    await user.click(tiles[2]!);
    expect(screen.getByTestId('option-card')).toHaveAccessibleName('Best');
    expect(chooseButton('Best', 1890000)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: choose('Better') })).toBeNull();
    expect(api.count(SIGN_KEY)).toBe(0);
  });

  it('a single option has no tiles, and a proposal with no tier called Better opens on the middle one', async () => {
    const [first, , last] = fixture().options;
    proposalApi(() => ({ body: fixture({ options: [first!] }) }));
    renderPage();
    expect(await screen.findByTestId('option-card')).toHaveAccessibleName('Good');
    expect(screen.queryAllByRole('radio')).toHaveLength(0);

    cleanup();
    proposalApi(() => ({ body: fixture({ options: [first!, { ...last!, tier: 'best' }] }) }));
    renderPage();
    // Two options and no Better: the page opens on the second (the middle of a list of two rounds up).
    expect(await screen.findByTestId('option-card')).toHaveAccessibleName('Best');
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('says the price is good until a plain date, with no countdown or pressure', async () => {
    proposalApi(() => ({ body: fixture() }));
    renderPage();
    await screen.findByTestId('option-card');
    const line = screen.getByText(/^Price good until /);
    expect(line.textContent).toMatch(/^Price good until [A-Z][a-z]{2} \d{1,2}(, \d{4})?\.$/);
    expect(document.body.textContent ?? '').not.toMatch(/offer ends|ends in|expires in|hurry|only \d+ left|countdown|limited time|act now/i);
  });

  it('shows the financing line only from what the option carries: monthly, APR, number of payments, total', async () => {
    proposalApi(() => ({ body: fixture() }));
    const { user } = renderPage();

    // Better: $215 a month, 120 payments at 8.99% APR, so the payments total $25,800 (215 x 120)
    expect(await screen.findByText(homeowner.financingMonthly('$215'))).toBeInTheDocument();
    expect(screen.getByText(homeowner.financingApr('8.99'))).toBeInTheDocument();
    expect(screen.getByText(homeowner.financingPayments(120))).toBeInTheDocument();
    expect(screen.getByText(homeowner.financingTotal('$25,800'))).toBeInTheDocument();
    expect(screen.getByText(homeowner.financingNote)).toBeInTheDocument();
    // No payoff month is made up: the page does not know when payments would start.
    expect(document.body.textContent ?? '').not.toMatch(/paid off/i);

    // Good carries no terms: there is no financing line at all, not a guess.
    await user.click(screen.getByRole('radio', { name: /^Good/ }));
    expect(screen.queryByText(/\/month/)).toBeNull();
    expect(screen.queryByText(/APR/)).toBeNull();
    expect(screen.queryByText(homeowner.financingNote)).toBeNull();
  });

  it('a monthly estimate without its terms (or terms without an estimate) shows no financing', async () => {
    const [good, better, best] = fixture().options;
    proposalApi(() => ({
      body: fixture({ options: [good!, { ...better!, financingTerms: null }, { ...best!, monthlyEstimateCents: null }] }),
    }));
    const { user } = renderPage();
    await screen.findByTestId('option-card');
    expect(screen.queryByText(/\/month/)).toBeNull();
    await user.click(screen.getByRole('radio', { name: /^Best/ }));
    expect(screen.queryByText(/\/month/)).toBeNull();
  });

  it('sign with keyboard only posts the exact body', async () => {
    proposalApi(() => ({ body: fixture() }));
    const { user } = renderPage();
    await screen.findAllByTestId('option-card');

    await tabTo(user, () => chooseButton());
    await user.keyboard('{Enter}');

    // The sheet reads top to bottom: the name, the drawing's Clear, the one consent, then the main button.
    const name = await screen.findByRole('textbox', { name: homeowner.nameLabel });
    await tabTo(user, () => name);
    await user.keyboard('Maria Lopez');

    await tabTo(user, () => screen.getByRole('button', { name: homeowner.clearDrawing }));
    const checkbox = screen.getByRole('checkbox', { name: homeowner.consentText });
    await tabTo(user, () => checkbox);
    await user.keyboard(' ');
    expect(checkbox).toBeChecked();

    const sign = await screen.findByRole('button', { name: homeowner.signAndAccept(1425000) });
    await tabTo(user, () => sign);
    await user.keyboard('{Enter}');

    await waitFor(() => expect(api.count(SIGN_KEY)).toBe(1));
    expect(api.sent(SIGN_KEY)).toEqual([{ optionId: MIDDLE_ID, consent: true, signerName: 'Maria Lopez', typedSignature: 'Maria Lopez' }]);
    const [body] = api.sent(SIGN_KEY) as Record<string, unknown>[];
    expect(Object.keys(body ?? {})).not.toContain('drawnSignature');
  });

  it("the sheet's keyboard order, with nothing between: the name, Clear, the one consent, then the main button", async () => {
    proposalApi(() => ({ body: fixture() }));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: choose() }));
    const name = await screen.findByRole('textbox', { name: homeowner.nameLabel });
    name.focus();
    await user.keyboard('{Tab}');
    expect(screen.getByRole('button', { name: homeowner.clearDrawing })).toHaveFocus();
    await user.keyboard('{Tab}');
    expect(screen.getByRole('checkbox', { name: homeowner.consentText })).toHaveFocus();
    await user.keyboard('{Tab}');
    expect(screen.getByRole('button', { name: homeowner.signAndAccept(1425000) })).toHaveFocus();
  });

  it('the sign sheet says what is signed and how it would be paid, and that financing is a separate approval', async () => {
    proposalApi(() => ({ body: fixture() }));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: choose() }));

    const sheet = await screen.findByRole('dialog', { name: homeowner.signTitle });
    // Three steps, Sign the current one
    const steps = within(sheet).getByRole('list', { name: homeowner.stepsLabel });
    expect(within(steps).getAllByRole('listitem').map((item) => item.textContent)).toEqual([homeowner.stepChoose, `2${homeowner.stepSign}`, `3${homeowner.stepDone}`]);
    expect(within(steps).getByText(homeowner.stepSign).closest('li')).toHaveAttribute('aria-current', 'step');
    // The summary names the roof and the tier once, then what the option is (here its first promise: its name is just its tier)
    expect(within(sheet).getByText(homeowner.optionKicker('Better'))).toBeInTheDocument();
    expect(within(sheet).getByText('Upgraded underlayment')).toBeInTheDocument();
    expect(within(sheet).getAllByText(/\bBetter\b/)).toHaveLength(1);
    // What is paid is a read-only list of facts, not two cards to choose between: nothing in it can be picked
    expect(within(sheet).getAllByText(money(1425000)).length).toBeGreaterThanOrEqual(1);
    expect(within(sheet).getByText(homeowner.howYouPay)).toBeInTheDocument();
    expect(within(sheet).queryAllByRole('radio')).toHaveLength(0);
    expect(within(sheet).getByText(homeowner.payTotal).closest('dl')).not.toBeNull();
    expect(within(sheet).getByText(homeowner.payMonthlyAmount('$215'))).toBeInTheDocument();
    expect(within(sheet).getByText(homeowner.payMonthlyTerms('8.99', 120))).toBeInTheDocument();
    expect(within(sheet).getByText(homeowner.financingSeparate)).toBeInTheDocument();
    // The consent is the versioned legal text, unchanged
    expect(within(sheet).getByRole('checkbox', { name: CONSENT_TEXT_V1 })).toBeInTheDocument();
    expect(within(sheet).getByText(ESTIMATE_CLAUSE_V1)).toBeInTheDocument();
  });

  it('the sign sheet for an option with no financing has no payment block and no financing sentence', async () => {
    proposalApi(() => ({ body: fixture() }));
    const { user } = renderPage();
    await user.click(await screen.findByRole('radio', { name: /^Good/ }));
    await user.click(screen.getByRole('button', { name: choose('Good', 990000) }));

    const sheet = await screen.findByRole('dialog', { name: homeowner.signTitle });
    expect(within(sheet).queryByText(homeowner.howYouPay)).toBeNull();
    expect(within(sheet).queryByText(homeowner.financingSeparate)).toBeNull();
  });

  it('the drawn signature path posts a PNG', async () => {
    const context = {
      setTransform: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,iVBORw0KGgo=');

    proposalApi(() => ({ body: fixture() }));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: choose() }));

    const pad = await screen.findByTestId('signature-pad');
    // jsdom has no pointer capture; the stand-in keeps the pad's calls to it working.
    Object.assign(pad, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
    fireEvent.pointerDown(pad, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(pad, { pointerId: 1, clientX: 60, clientY: 40 });
    fireEvent.pointerUp(pad, { pointerId: 1, clientX: 60, clientY: 40 });

    await user.type(screen.getByRole('textbox', { name: homeowner.nameLabel }), 'Maria Lopez');
    await user.click(screen.getByRole('checkbox', { name: homeowner.consentText }));
    await user.click(screen.getByRole('button', { name: homeowner.signAndAccept(1425000) }));

    await waitFor(() => expect(api.count(SIGN_KEY)).toBe(1));
    const [body] = api.sent(SIGN_KEY) as Record<string, unknown>[];
    expect(body?.drawnSignature).toBe('iVBORw0KGgo=');
  });

  it('a drawing on a closed sheet is never sent: reopening starts with an empty pad', async () => {
    const context = {
      setTransform: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,iVBORw0KGgo=');

    proposalApi(() => ({ body: fixture() }));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: choose() }));
    const pad = await screen.findByTestId('signature-pad');
    Object.assign(pad, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
    fireEvent.pointerDown(pad, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(pad, { pointerId: 1, clientX: 60, clientY: 40 });
    fireEvent.pointerUp(pad, { pointerId: 1, clientX: 60, clientY: 40 });

    // Close the sheet with the drawing on it, then choose again: the pad is empty, so nothing is drawn.
    await user.click(screen.getByRole('button', { name: homeowner.closeLabel }));
    await waitFor(() => expect(screen.queryByTestId('signature-pad')).toBeNull());
    await user.click(screen.getByRole('button', { name: choose() }));
    await screen.findByTestId('signature-pad');
    await user.type(screen.getByRole('textbox', { name: homeowner.nameLabel }), 'Maria Lopez');
    await user.click(screen.getByRole('checkbox', { name: homeowner.consentText }));
    await user.click(screen.getByRole('button', { name: homeowner.signAndAccept(1425000) }));

    await waitFor(() => expect(api.count(SIGN_KEY)).toBe(1));
    const [body] = api.sent(SIGN_KEY) as Record<string, unknown>[];
    expect(Object.keys(body ?? {})).not.toContain('drawnSignature');
  });

  it('a sign refused because someone else signed first shows the signed page underneath', async () => {
    let signedElsewhere = false;
    proposalApi(() => ({
      body: signedElsewhere
        ? fixture({ status: 'signed', signed: { optionId: MIDDLE_ID, name: 'Jo Lopez', at: '2026-10-12T15:00:00.000Z', pdfReady: true } })
        : fixture(),
    }));
    api.routes[SIGN_KEY] = () => {
      signedElsewhere = true;
      return { status: 409, body: { error: 'This proposal is already signed.' } };
    };
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: choose() }));
    await user.type(screen.getByRole('textbox', { name: homeowner.nameLabel }), 'Maria Lopez');
    await user.click(screen.getByRole('checkbox', { name: homeowner.consentText }));
    await user.click(screen.getByRole('button', { name: homeowner.signAndAccept(1425000) }));

    expect(await screen.findByText(homeowner.signedTitle)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Choose / })).toBeNull();
    expect(api.count(GET_KEY)).toBeGreaterThanOrEqual(2);
  });

  it('a sign refused because the link is gone shows the expired page underneath', async () => {
    let gone = false;
    proposalApi(() => (gone ? { status: 410, body: { error: 'x', companyPhone: null } } : { body: fixture() }));
    api.routes[SIGN_KEY] = () => {
      gone = true;
      return { status: 410, body: { error: 'This proposal link has expired.', companyPhone: null } };
    };
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: choose() }));
    await user.type(screen.getByRole('textbox', { name: homeowner.nameLabel }), 'Maria Lopez');
    await user.click(screen.getByRole('checkbox', { name: homeowner.consentText }));
    await user.click(screen.getByRole('button', { name: homeowner.signAndAccept(1425000) }));

    expect(await screen.findByText(homeowner.expiredTitle)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Choose / })).toBeNull();
  });

  it('a signed proposal whose copy is being made is asked again every few seconds until the download shows, then no more', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reads = 0;
      const signed = (pdfReady: boolean) =>
        fixture({ status: 'signed', signed: { optionId: MIDDLE_ID, name: 'Maria Lopez', at: '2026-10-12T15:00:00.000Z', pdfReady } });
      proposalApi(() => {
        reads += 1;
        return { body: signed(reads >= 3) };
      });
      renderPage();

      expect(await screen.findByText(homeowner.pdfPreparing)).toBeInTheDocument();
      expect(screen.queryByText(homeowner.pdfPreparingLate)).toBeNull();
      expect(screen.queryByRole('link', { name: homeowner.downloadPdf })).toBeNull();
      await vi.advanceTimersByTimeAsync(SIGNED_PDF_POLL_MS);
      await waitFor(() => expect(api.count(GET_KEY)).toBe(2));
      await vi.advanceTimersByTimeAsync(SIGNED_PDF_POLL_MS);
      expect(await screen.findByRole('link', { name: homeowner.downloadPdf })).toHaveAttribute('href', signedPdfUrl(TOKEN));
      expect(api.count(GET_KEY)).toBe(3);

      // Ready: the page stops asking.
      await vi.advanceTimersByTimeAsync(SIGNED_PDF_POLL_MS * 3);
      expect(api.count(GET_KEY)).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a signed copy that is still not ready when the page stops asking says to check back, not that the page updates on its own', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      proposalApi(() => ({
        body: fixture({ status: 'signed', signed: { optionId: MIDDLE_ID, name: 'Maria Lopez', at: '2026-10-12T15:00:00.000Z', pdfReady: false } }),
      }));
      renderPage();

      expect(await screen.findByText(homeowner.pdfPreparing)).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(SIGNED_PDF_POLL_MS * (SIGNED_PDF_POLL_LIMIT + 2));
      expect(await screen.findByText(homeowner.pdfPreparingLate)).toBeInTheDocument();
      expect(screen.queryByText(homeowner.pdfPreparing)).toBeNull();
      expect(api.count(GET_KEY)).toBe(SIGNED_PDF_POLL_LIMIT);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sign shows validation errors before posting', async () => {
    proposalApi(() => ({ body: fixture() }));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: choose() }));

    await user.click(await screen.findByRole('button', { name: homeowner.signAndAccept(1425000) }));

    expect(await screen.findByText(homeowner.consentMissing)).toBeInTheDocument();
    expect(screen.getByText(homeowner.nameMissing)).toBeInTheDocument();
    expect(api.count(SIGN_KEY)).toBe(0);
  });

  it('an already signed proposal shows the signed state', async () => {
    proposalApi(() => ({
      body: fixture({ status: 'signed', signed: { optionId: MIDDLE_ID, name: 'Maria Lopez', at: '2026-10-12T15:00:00.000Z', pdfReady: true } }),
    }));
    renderPage();

    expect(await screen.findByText(homeowner.signedTitle)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: homeowner.downloadPdf })).toHaveAttribute('href', signedPdfUrl(TOKEN));
    expect(screen.queryByRole('button', { name: /^Choose / })).toBeNull();
  });

  it('an expired proposal shows the expired state', async () => {
    proposalApi(() => ({ body: fixture({ status: 'expired' }) }));
    renderPage();

    expect(await screen.findByText(homeowner.expiredTitle)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Choose / })).toBeNull();
    // The company can send a fresh one, and the call to it is the page's one real action: a button-sized link that dials
    expect(screen.getByText(homeowner.expiredBody('Acme Roofing'))).toBeInTheDocument();
    const call = screen.getByRole('link', { name: homeowner.callUs('Acme Roofing') });
    expect(call).toHaveAttribute('href', 'tel:+15555550100');
    expect(call).toHaveAttribute('data-size', 'lg');
  });

  it('a declined proposal says the company was told and keeps the call as a quiet, button-sized link', async () => {
    proposalApi(() => ({ body: fixture({ status: 'declined' }) }));
    renderPage();

    expect(await screen.findByText(homeowner.declinedTitle)).toBeInTheDocument();
    const call = screen.getByRole('link', { name: homeowner.callUs('Acme Roofing') });
    expect(call).toHaveAttribute('href', 'tel:+15555550100');
    expect(call).toHaveAttribute('data-variant', 'ghost');
    expect(call).toHaveAttribute('data-size', 'lg');
  });

  it('a gone link shows the plain message', async () => {
    proposalApi(() => ({ status: 410, body: { error: 'x', companyPhone: '+15555550100' } }));
    renderPage();

    expect(await screen.findByText(homeowner.expiredTitle)).toBeInTheDocument();
    expect(document.querySelector('a[href="tel:+15555550100"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^Choose / })).toBeNull();

    cleanup();
    api.routes[GET_KEY] = () => ({ status: 404, body: { error: 'x' } });
    renderPage();

    expect(await screen.findByText(homeowner.goneTitle)).toBeInTheDocument();
  });

  it('decline with reason posts it', async () => {
    proposalApi(() => ({ body: fixture() }));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: homeowner.declineLink }));

    await user.type(screen.getByRole('textbox', { name: homeowner.declineReasonLabel }), 'Too expensive');
    await user.click(screen.getByRole('button', { name: homeowner.declineSend }));

    await waitFor(() => expect(api.count(DECLINE_KEY)).toBe(1));
    expect(api.sent(DECLINE_KEY)).toEqual([{ reason: 'Too expensive' }]);
  });

  it('the button that sends a decline is the kit ink button, never the company colour (it would turn that colour under a thumb that just opened the sheet)', async () => {
    proposalApi(() => ({ body: fixture() }));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: homeowner.declineLink }));

    expect(screen.getByRole('button', { name: homeowner.declineSend })).toHaveAttribute('data-variant', 'ink');
  });

  it('decline with no reason posts an empty body', async () => {
    proposalApi(() => ({ body: fixture() }));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: homeowner.declineLink }));

    await user.click(screen.getByRole('button', { name: homeowner.declineSend }));

    await waitFor(() => expect(api.count(DECLINE_KEY)).toBe(1));
    expect(api.sent(DECLINE_KEY)).toEqual([{}]);
  });

  it('the view event is posted once per load', async () => {
    proposalApi(() => ({ body: fixture() }));
    const { user } = renderPage();
    await screen.findAllByTestId('option-card');
    await waitFor(() => expect(api.count(VIEW_KEY)).toBe(1));

    // Declining refetches the proposal; the view is still recorded only once.
    await user.click(screen.getByRole('button', { name: homeowner.declineLink }));
    await user.click(screen.getByRole('button', { name: homeowner.declineSend }));
    await waitFor(() => expect(api.count(DECLINE_KEY)).toBe(1));
    await waitFor(() => expect(api.count(GET_KEY)).toBeGreaterThanOrEqual(2));

    expect(api.count(VIEW_KEY)).toBe(1);
  });

  it('sets noindex', async () => {
    proposalApi(() => ({ body: fixture() }));
    renderPage();
    await screen.findAllByTestId('option-card');

    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');

    cleanup();
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  });

  it('consent and clause text match the legal text', () => {
    expect(homeowner.consentText).toBe(CONSENT_TEXT_V1);
    expect(homeowner.estimateClause).toBe(ESTIMATE_CLAUSE_V1);
    expect(homeowner.consentText).toBe(
      'I agree to sign electronically and to receive this agreement electronically. I can ask for a paper copy.',
    );
    expect(homeowner.estimateClause).toBe(
      "This price is based on an estimate of your roof's size. If the measured size differs, we'll show you the updated price and ask you to confirm before work starts.",
    );
  });

  it('the public requests carry no credentials and use relative urls', async () => {
    proposalApi(() => ({ body: fixture() }));
    const stubbed = globalThis.fetch;
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    // Wraps the stub so the request init (which the stub does not keep) can be checked.
    const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), init });
      return stubbed(input, init);
    });
    vi.stubGlobal('fetch', spy);

    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: choose() }));
    await user.click(screen.getByRole('checkbox', { name: homeowner.consentText }));
    await user.type(screen.getByRole('textbox', { name: homeowner.nameLabel }), 'Maria Lopez');
    await user.click(screen.getByRole('button', { name: homeowner.signAndAccept(1425000) }));
    await waitFor(() => expect(api.count(SIGN_KEY)).toBe(1));

    const publicCalls = sent.filter((call) => call.url.startsWith('/api/public/'));
    expect(publicCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of publicCalls) {
      expect(call.url.startsWith('/api/public/proposals/')).toBe(true);
      expect(call.init?.credentials).toBe('omit');
    }
  });
});

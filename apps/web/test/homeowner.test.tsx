import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_TEXT_V1, ESTIMATE_CLAUSE_V1, type PublicProposalView } from '@roofline/shared';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { homeowner, money } from '../src/copy/homeowner.ts';
import { SIGNED_PDF_POLL_MS, signedPdfUrl } from '../src/features/homeowner/api.ts';
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

/** The Choose button of an option, by the option's name. */
const chooseButton = (name: string) => screen.getByRole('button', { name: homeowner.chooseOption(name) });

/** Presses Tab until `target()` has focus. Keyboard only: no click and no focus() call. */
async function tabTo(user: UserEvent, target: () => HTMLElement, limit = 40): Promise<void> {
  for (let step = 0; step < limit; step += 1) {
    if (document.activeElement === target()) return;
    await user.tab();
  }
  throw new Error('Could not tab to the wanted control.');
}

describe('the homeowner page', () => {
  it('renders the three options', async () => {
    proposalApi(() => ({ body: fixture() }));
    renderPage();

    const cards = await screen.findAllByTestId('option-card');
    expect(cards).toHaveLength(3);
    for (const option of fixture().options) {
      expect(screen.getByText(option.name)).toBeInTheDocument();
      expect(screen.getByText(money(option.totalCents))).toBeInTheDocument();
    }
    expect(screen.getAllByText(homeowner.mostPopular)).toHaveLength(1);
    expect(document.body.textContent ?? '').not.toMatch(/per square|per sq|\/sq/i);
  });

  it('shows the financing line', async () => {
    proposalApi(() => ({ body: fixture() }));
    renderPage();

    expect(await screen.findByText(homeowner.monthlyLine('$215', 120, '8.99'))).toBeInTheDocument();
  });

  it('sign with keyboard only posts the exact body', async () => {
    proposalApi(() => ({ body: fixture() }));
    const { user } = renderPage();
    await screen.findAllByTestId('option-card');

    await tabTo(user, () => chooseButton('Better'));
    await user.keyboard('{Enter}');

    const checkbox = await screen.findByRole('checkbox', { name: homeowner.consentText });
    await tabTo(user, () => checkbox);
    await user.keyboard(' ');
    expect(checkbox).toBeChecked();

    const name = screen.getByRole('textbox', { name: homeowner.nameLabel });
    await tabTo(user, () => name);
    await user.keyboard('Maria Lopez');

    await tabTo(user, () => screen.getByRole('button', { name: homeowner.clearDrawing }));
    const sign = await screen.findByRole('button', { name: homeowner.signAndAccept(1425000) });
    await tabTo(user, () => sign);
    await user.keyboard('{Enter}');

    await waitFor(() => expect(api.count(SIGN_KEY)).toBe(1));
    expect(api.sent(SIGN_KEY)).toEqual([{ optionId: MIDDLE_ID, consent: true, signerName: 'Maria Lopez', typedSignature: 'Maria Lopez' }]);
    const [body] = api.sent(SIGN_KEY) as Record<string, unknown>[];
    expect(Object.keys(body ?? {})).not.toContain('drawnSignature');
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
    await user.click(await screen.findByRole('button', { name: homeowner.chooseOption('Better') }));

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
    await user.click(await screen.findByRole('button', { name: homeowner.chooseOption('Better') }));
    const pad = await screen.findByTestId('signature-pad');
    Object.assign(pad, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
    fireEvent.pointerDown(pad, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(pad, { pointerId: 1, clientX: 60, clientY: 40 });
    fireEvent.pointerUp(pad, { pointerId: 1, clientX: 60, clientY: 40 });

    // Close the sheet with the drawing on it, then choose again: the pad is empty, so nothing is drawn.
    await user.click(screen.getByRole('button', { name: homeowner.closeLabel }));
    await waitFor(() => expect(screen.queryByTestId('signature-pad')).toBeNull());
    await user.click(screen.getByRole('button', { name: homeowner.chooseOption('Better') }));
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
    await user.click(await screen.findByRole('button', { name: homeowner.chooseOption('Better') }));
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
    await user.click(await screen.findByRole('button', { name: homeowner.chooseOption('Better') }));
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

  it('sign shows validation errors before posting', async () => {
    proposalApi(() => ({ body: fixture() }));
    const { user } = renderPage();
    await user.click(await screen.findByRole('button', { name: homeowner.chooseOption('Better') }));

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
    await user.click(await screen.findByRole('button', { name: homeowner.chooseOption('Better') }));
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

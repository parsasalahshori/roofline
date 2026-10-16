import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUOTE_CONSENT_VERSION, quoteConsentText, type PublicQuoteConfig } from '@roofline/shared';
import { quote, quoteMoney } from '../src/copy/quote.ts';
import type { EstimateAnswer } from '../src/features/quote/api.ts';
import { embedSnippet, RESIZE_MESSAGE } from '../src/features/quote/embed.ts';
import { checkLead, QuotePage } from '../src/features/quote/QuotePage.tsx';
import { thumbLayout } from '../src/features/quote/RoofThumb.tsx';
import { type Reply, stubApi } from './helpers.tsx';

/*
 * The public instant quote page (/q/:slug): address -> scan -> ranges -> the request form -> thanks, with the
 * fallback when the company's daily limit is reached, validation, and server errors. fetch is stubbed.
 */

const SLUG = 'summit-ridge';
const BASE = `/api/public/quote/${SLUG}`;

const CONFIG: PublicQuoteConfig = {
  slug: SLUG,
  companyName: 'Summit Ridge Roofing',
  logoUrl: null,
  accentColor: '#1f6feb',
  phone: '+14025550100',
  products: ['windows', 'roof', 'gutters'],
  booking: false,
  consent: { version: QUOTE_CONSENT_VERSION, text: quoteConsentText('Summit Ridge Roofing') },
  turnstileSiteKey: null,
};

const READY: EstimateAnswer = {
  quoteId: '11111111-1111-4111-8111-111111111111',
  status: 'ready',
  address: '4810 Underwood Ave, Omaha, NE 68132',
  roof: { squares: 24.5, range: { lowCents: 1_250_000, highCents: 1_980_000 } },
  windows: { count: 18, range: { lowCents: 950_000, highCents: 2_400_000 } },
  gutters: null,
  outline: {
    center: [-96.0, 41.25],
    ring: [
      [-96.0002, 41.2499],
      [-95.9998, 41.2499],
      [-95.9998, 41.2501],
      [-96.0002, 41.2501],
    ],
  },
  formToken: 'tok.sig',
};

const FALLBACK: EstimateAnswer = { ...READY, status: 'fallback', roof: null, windows: null, gutters: null, outline: null };

let api: ReturnType<typeof stubApi>;

function setup(routes: Record<string, (r: { body: unknown }) => Reply>) {
  api = stubApi({ [`GET ${BASE}`]: () => ({ body: CONFIG }), ...routes });
  render(<QuotePage slug={SLUG} />);
}

beforeEach(() => {
  vi.stubEnv('VITE_MEASURE_SCAN_MS', '0');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  expect(api?.unexpected ?? []).toEqual([]);
});

async function getEstimate(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(quote.addressLabel), READY.address);
  await user.click(screen.getByRole('button', { name: quote.measureButton }));
}

async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(quote.firstName), 'Dana');
  await user.type(screen.getByLabelText(quote.lastName), 'Whitfield');
  await user.type(screen.getByLabelText(quote.email), 'dana@example.com');
  await user.type(screen.getByLabelText(quote.phone), '(402) 555-0142');
}

describe('QuotePage', () => {
  it('runs the whole flow: ranges only, the final-price line, the form with consent, then thanks', async () => {
    const user = userEvent.setup();
    setup({
      [`POST ${BASE}/estimate`]: () => ({ body: READY }),
      [`POST ${BASE}/lead`]: () => ({ status: 201, body: { ok: true, booked: null } }),
    });
    expect(await screen.findByText(CONFIG.companyName)).toBeInTheDocument();
    await getEstimate(user);

    expect(await screen.findByRole('heading', { name: quote.resultsTitle })).toBeInTheDocument();
    expect(screen.getByText(quote.roofLine(24.5))).toBeInTheDocument();
    expect(screen.getByText(quote.range(1_250_000, 1_980_000))).toBeInTheDocument();
    expect(screen.getByText(quote.windowsLine(18))).toBeInTheDocument();
    expect(screen.getByText(quote.range(950_000, 2_400_000))).toBeInTheDocument();
    expect(screen.getByText(quote.finalNote)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: quote.outlineAlt })).toBeInTheDocument();
    expect(api.sent(`POST ${BASE}/estimate`)).toEqual([{ address: READY.address, website: '' }]);

    await user.click(screen.getByRole('button', { name: quote.continueButton }));
    // Products with a range shown are ticked; gutters (no range) is not.
    expect(screen.getByRole('checkbox', { name: quote.productName('windows') })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: quote.productName('roof') })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: quote.productName('gutters') })).not.toBeChecked();
    // The ZIP is filled from the found address; the full consent text is shown.
    expect(screen.getByLabelText(quote.postalCode)).toHaveValue('68132');
    expect(screen.getByText(CONFIG.consent.text)).toBeInTheDocument();

    await fillForm(user);
    await user.click(screen.getByRole('checkbox', { name: quote.consentLabel }));
    await user.click(screen.getByRole('button', { name: quote.submit }));

    expect(await screen.findByRole('heading', { name: quote.doneTitle('Dana') })).toBeInTheDocument();
    expect(api.sent(`POST ${BASE}/lead`)).toEqual([
      {
        quoteId: READY.quoteId,
        firstName: 'Dana',
        lastName: 'Whitfield',
        email: 'dana@example.com',
        phone: '(402) 555-0142',
        postalCode: '68132',
        products: ['windows', 'roof'],
        consent: true,
        consentVersion: QUOTE_CONSENT_VERSION,
        formToken: READY.formToken,
        website: '',
      },
    ]);
    // Nothing personal ever went in a URL.
    for (const call of api.calls) expect(call.url).not.toMatch(/Dana|555|example|Underwood/);
  });

  it('checks the form before sending: consent required, phone, email, ZIP and names', async () => {
    const user = userEvent.setup();
    setup({ [`POST ${BASE}/estimate`]: () => ({ body: READY }) });
    await getEstimate(user);
    await user.click(await screen.findByRole('button', { name: quote.continueButton }));
    await user.type(screen.getByLabelText(quote.phone), '12');
    await user.click(screen.getByRole('button', { name: quote.submit }));
    expect(screen.getByText(quote.consentRequired)).toBeInTheDocument();
    expect(screen.getByText(quote.phoneInvalid)).toBeInTheDocument();
    expect(screen.getByText(quote.emailInvalid)).toBeInTheDocument();
    expect(screen.getByText(quote.required(quote.firstName))).toBeInTheDocument();
    expect(api.count(`POST ${BASE}/lead`)).toBe(0);
  });

  it('past the daily limit shows the call-back fallback and still takes the request, every service ticked', async () => {
    const user = userEvent.setup();
    setup({
      [`POST ${BASE}/estimate`]: () => ({ body: FALLBACK }),
      [`POST ${BASE}/lead`]: () => ({ status: 201, body: { ok: true, booked: null } }),
    });
    await getEstimate(user);
    expect(await screen.findByRole('heading', { name: quote.fallbackTitle })).toBeInTheDocument();
    expect(screen.queryByText(quote.resultsTitle)).toBeNull();
    for (const p of CONFIG.products) expect(screen.getByRole('checkbox', { name: quote.productName(p) })).toBeChecked();
    await fillForm(user);
    await user.click(screen.getByRole('checkbox', { name: quote.consentLabel }));
    await user.click(screen.getByRole('button', { name: quote.submit }));
    expect(await screen.findByRole('heading', { name: quote.doneTitle('Dana') })).toBeInTheDocument();
  });

  it('an address that is not found comes back to the address step with the message on the field', async () => {
    const user = userEvent.setup();
    setup({ [`POST ${BASE}/estimate`]: () => ({ status: 422, body: { error: 'We could not find that address.', field: 'address' } }) });
    await getEstimate(user);
    const field = await screen.findByLabelText(quote.addressLabel);
    expect(await screen.findByText('We could not find that address.')).toBeInTheDocument();
    expect(field).toHaveValue(READY.address);
  });

  it('a server error on the request is shown on its field, or as a banner; too many is the slow-down line', async () => {
    const user = userEvent.setup();
    let reply: Reply = { status: 400, body: { error: 'Please enter a 5-digit ZIP code.', field: 'postalCode' } };
    setup({ [`POST ${BASE}/estimate`]: () => ({ body: READY }), [`POST ${BASE}/lead`]: () => reply });
    await getEstimate(user);
    await user.click(await screen.findByRole('button', { name: quote.continueButton }));
    await fillForm(user);
    await user.click(screen.getByRole('checkbox', { name: quote.consentLabel }));
    await user.click(screen.getByRole('button', { name: quote.submit }));
    expect(await screen.findByText('Please enter a 5-digit ZIP code.')).toBeInTheDocument();
    reply = { status: 429, body: { error: 'x' } };
    await user.click(screen.getByRole('button', { name: quote.submit }));
    expect(await screen.findByText(quote.tooFast)).toBeInTheDocument();
  });

  it('an unknown or turned-off page says so', async () => {
    api = stubApi({ [`GET ${BASE}`]: () => ({ status: 404, body: { error: 'nope' } }) });
    render(<QuotePage slug={SLUG} />);
    expect(await screen.findByRole('heading', { name: quote.notFoundTitle })).toBeInTheDocument();
  });

  it('offers visit times when booking is on and sends the picked one', async () => {
    const user = userEvent.setup();
    const start = '2026-10-16T15:00:00.000Z';
    api = stubApi({
      [`GET ${BASE}`]: () => ({ body: { ...CONFIG, booking: true } }),
      [`POST ${BASE}/estimate`]: () => ({ body: READY }),
      [`GET ${BASE}/slots`]: () => ({ body: { timeZone: 'America/Chicago', slots: [{ id: start, start, end: '2026-10-16T16:00:00.000Z' }] } }),
      [`POST ${BASE}/lead`]: () => ({ status: 201, body: { ok: true, booked: { start, end: '2026-10-16T16:00:00.000Z' } } }),
    });
    render(<QuotePage slug={SLUG} />);
    await getEstimate(user);
    await user.click(await screen.findByRole('button', { name: quote.continueButton }));
    const group = await screen.findByRole('group', { name: quote.slotsTitle });
    const radios = await within(group).findAllByRole('radio');
    expect(radios).toHaveLength(2);
    await user.click(radios[1]!);
    await fillForm(user);
    await user.click(screen.getByRole('checkbox', { name: quote.consentLabel }));
    await user.click(screen.getByRole('button', { name: quote.submit }));
    await waitFor(() => expect(api.sent(`POST ${BASE}/lead`)).toHaveLength(1));
    expect((api.sent(`POST ${BASE}/lead`)[0] as { slotId: string }).slotId).toBe(start);
  });
});

describe('quote helpers', () => {
  it('checkLead mirrors the server rules', () => {
    const ok = { firstName: 'A', lastName: 'B', email: 'a@b.co', phone: '402-555-0142', postalCode: '68132', products: ['roof' as const], consent: true, slotId: '', website: '' };
    expect(checkLead(ok)).toEqual({});
    expect(Object.keys(checkLead({ ...ok, consent: false, products: [], postalCode: '1' })).sort()).toEqual(['consent', 'postalCode', 'products']);
  });

  it('lays tiles out round the outline and keeps every corner inside the picture', () => {
    const layout = thumbLayout(READY.outline!.ring, READY.outline!.center);
    expect(layout.tiles.length).toBeGreaterThan(0);
    for (const [x, y] of layout.points) {
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(100);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(100);
    }
  });

  it('the embed snippet checks the page origin and only reads a height', () => {
    const code = embedSnippet('https://app.roofline.test/q/summit-ridge', 'Instant estimate');
    expect(code).toContain('<iframe id="roofline-quote" src="https://app.roofline.test/q/summit-ridge"');
    expect(code).toContain('e.origin !== "https://app.roofline.test"');
    expect(code).toContain(RESIZE_MESSAGE);
  });

  it('money is whole dollars', () => {
    expect(quoteMoney(1_250_000)).toBe('$12,500');
  });
});

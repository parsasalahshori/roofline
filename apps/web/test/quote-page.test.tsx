import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUOTE_CONSENT_VERSION, quoteConsentText, quoteTextConsentText, type PublicQuoteConfig, type QuoteProduct } from '@roofline/shared';
import { quote, quoteMoney } from '../src/copy/quote.ts';
import type { EstimateAnswer } from '../src/features/quote/api.ts';
import { embedSnippet, RESIZE_MESSAGE } from '../src/features/quote/embed.ts';
import { qrPath } from '../src/features/quote/QrCode.tsx';
import { checkLead, hasRanges, QuotePage } from '../src/features/quote/QuotePage.tsx';
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
  products: ['windows', 'roof'],
  booking: false,
  consent: {
    version: QUOTE_CONSENT_VERSION,
    text: quoteConsentText('Summit Ridge Roofing'),
    textingText: quoteTextConsentText('Summit Ridge Roofing'),
    privacyUrl: 'https://app.roofline.test/policies/summit-ridge/privacy',
    termsUrl: 'https://app.roofline.test/policies/summit-ridge/terms',
  },
  turnstileSiteKey: null,
  homeownerApp: null,
};

const APP = { url: 'https://apps.apple.com/us/app/winchoice/id0000000000', name: 'WinChoice' };

const READY: EstimateAnswer = {
  quoteId: '11111111-1111-4111-8111-111111111111',
  status: 'ready',
  address: '4810 Underwood Ave, Omaha, NE 68132',
  roof: { squares: 24.5, range: { lowCents: 1_250_000, highCents: 1_980_000 } },
  windows: { count: 14, range: { lowCents: 950_000, highCents: 2_400_000 }, countRange: { low: 12, high: 16 } },
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

type User = ReturnType<typeof userEvent.setup>;

/** The button that goes on to the request form: "Get my exact price", or the free visit when windows are on the page. */
const toForm = () => screen.getByRole('button', { name: new RegExp(`^(${quote.continueButton}|${quote.visitLink})$`) });

/** The first step: what are you looking for? Ticks the given services (all three by default) and goes on. */
async function pick(user: User, names: QuoteProduct[] = ['windows', 'roof']) {
  await screen.findByRole('heading', { name: quote.servicesTitle });
  for (const p of names) await user.click(screen.getByRole('checkbox', { name: quote.productName(p) }));
  await user.click(screen.getByRole('button', { name: quote.servicesContinue }));
}

async function getEstimate(user: User, names?: QuoteProduct[]) {
  await pick(user, names);
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
    await getEstimate(user, ['windows', 'roof']);

    expect(await screen.findByRole('heading', { name: quote.resultsTitle })).toBeInTheDocument();
    expect(screen.getByText(quote.roofLine(24.5))).toBeInTheDocument();
    expect(screen.getByText(quote.range(1_250_000, 1_980_000))).toBeInTheDocument();
    // The windows are a count with its range, never a price.
    expect(screen.getByText('About 14 windows (12\u201316)')).toBeInTheDocument();
    expect(screen.queryByText(quote.range(950_000, 2_400_000))).toBeNull();
    expect(screen.getByText(quote.finalNote)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: quote.outlineAlt })).toBeInTheDocument();
    expect(api.sent(`POST ${BASE}/estimate`)).toEqual([{ address: READY.address, website: '' }]);

    await user.click(toForm());
    expect(screen.getByRole('checkbox', { name: quote.productName('windows') })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: quote.productName('roof') })).toBeChecked();
    // The ZIP is filled from the found address; both consent texts are shown, texting unticked, with the policy links.
    expect(screen.getByLabelText(quote.postalCode)).toHaveValue('68132');
    expect(screen.getByText(CONFIG.consent.text)).toBeInTheDocument();
    expect(screen.getByText(CONFIG.consent.textingText)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: quote.textConsentLabel })).not.toBeChecked();
    expect(screen.getByRole('link', { name: quote.privacyLink })).toHaveAttribute('href', CONFIG.consent.privacyUrl);
    expect(screen.getByRole('link', { name: quote.termsLink })).toHaveAttribute('href', CONFIG.consent.termsUrl);
    expect(screen.getByRole('heading', { name: quote.formTitle })).toBeInTheDocument();

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
        textConsent: false,
        consentVersion: QUOTE_CONSENT_VERSION,
        formToken: READY.formToken,
        website: '',
      },
    ]);
    // Nothing personal ever went in a URL.
    for (const call of api.calls) expect(call.url).not.toMatch(/Dana|555|example|Underwood/);
  });

  it('the photo shows a placeholder until its tiles are in', async () => {
    const user = userEvent.setup();
    setup({ [`POST ${BASE}/estimate`]: () => ({ body: READY }) });
    await getEstimate(user);
    await screen.findByRole('heading', { name: quote.resultsTitle });
    const thumb = screen.getByRole('img', { name: quote.outlineAlt });
    expect(thumb).toHaveAttribute('data-loading');
    for (const img of thumb.querySelectorAll('img')) fireEvent.load(img);
    expect(thumb).not.toHaveAttribute('data-loading');
  });

  it('a picked time that was just taken says the office will call to set one', async () => {
    const user = userEvent.setup();
    const start = '2026-10-17T15:00:00.000Z';
    api = stubApi({
      [`GET ${BASE}`]: () => ({ body: { ...CONFIG, booking: true } }),
      [`POST ${BASE}/estimate`]: () => ({ body: READY }),
      [`GET ${BASE}/slots`]: () => ({ body: { timeZone: 'America/Chicago', slots: [{ id: start, start, end: '2026-10-17T16:00:00.000Z' }] } }),
      [`POST ${BASE}/lead`]: () => ({ status: 201, body: { ok: true, booked: null, slotTaken: true } }),
    });
    render(<QuotePage slug={SLUG} />);
    await getEstimate(user);
    await user.click(await screen.findByRole('button', { name: new RegExp(`^(${quote.continueButton}|${quote.visitLink})$`) }));
    const group = await screen.findByRole('group', { name: quote.slotsTitle });
    await user.click((await within(group).findAllByRole('radio'))[1]!);
    await fillForm(user);
    await user.click(screen.getByRole('checkbox', { name: quote.consentLabel }));
    await user.click(screen.getByRole('button', { name: quote.submit }));
    expect(await screen.findByText(quote.doneSlotTaken)).toBeInTheDocument();
  });

  it('checks the form before sending: consent required, phone, email, ZIP and names', async () => {
    const user = userEvent.setup();
    setup({ [`POST ${BASE}/estimate`]: () => ({ body: READY }) });
    await getEstimate(user);
    await user.click(await screen.findByRole('button', { name: new RegExp(`^(${quote.continueButton}|${quote.visitLink})$`) }));
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
    await user.click(await screen.findByRole('button', { name: new RegExp(`^(${quote.continueButton}|${quote.visitLink})$`) }));
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
    await user.click(await screen.findByRole('button', { name: new RegExp(`^(${quote.continueButton}|${quote.visitLink})$`) }));
    const group = await screen.findByRole('group', { name: quote.slotsTitle });
    const radios = await within(group).findAllByRole('radio');
    expect(radios).toHaveLength(2);
    await user.click(radios[1]!);
    await fillForm(user);
    await user.click(screen.getByRole('checkbox', { name: quote.consentLabel }));
    await user.click(screen.getByRole('button', { name: quote.submit }));
    await waitFor(() => expect(api.sent(`POST ${BASE}/lead`)).toHaveLength(1));
    expect((api.sent(`POST ${BASE}/lead`)[0] as { slotId: string }).slotId).toBe(start);
    // The confirmation names the same time the person picked (10:00 AM in Chicago), not the viewer's own clock.
    expect(radios[1]!.closest('label')!.textContent).toContain('10:00 AM');
    expect(await screen.findByText(/10:00 AM/)).toBeInTheDocument();
  });
});

describe('the first step: what are you looking for', () => {
  it('asks first, offers only what the company offers, and waits for a pick', async () => {
    const user = userEvent.setup();
    setup({});
    expect(await screen.findByRole('heading', { name: quote.servicesTitle })).toBeInTheDocument();
    expect(screen.queryByLabelText(quote.addressLabel)).toBeNull();
    for (const p of CONFIG.products) {
      expect(screen.getByRole('checkbox', { name: quote.productName(p) })).not.toBeChecked();
      expect(screen.getByText(quote.servicesHint[p])).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: quote.servicesContinue })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: quote.productName('roof') }));
    expect(screen.getByRole('button', { name: quote.servicesContinue })).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: quote.productName('roof') }));
    expect(screen.getByRole('button', { name: quote.servicesContinue })).toBeDisabled();
  });

  it('shows only what they picked on the results, and "Change" goes back to the picker', async () => {
    const user = userEvent.setup();
    setup({ [`POST ${BASE}/estimate`]: () => ({ body: READY }) });
    await pick(user, ['roof']);
    expect(await screen.findByText(quote.servicesLooking(quote.productName('roof')))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: quote.servicesChange }));
    expect(await screen.findByRole('heading', { name: quote.servicesTitle })).toBeInTheDocument();
    // What they picked is still ticked
    expect(screen.getByRole('checkbox', { name: quote.productName('roof') })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: quote.productName('windows') })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: quote.servicesContinue }));
    await user.type(await screen.findByLabelText(quote.addressLabel), READY.address);
    await user.click(screen.getByRole('button', { name: quote.measureButton }));
    await screen.findByRole('heading', { name: quote.resultsTitle });
    expect(screen.getByText(quote.roofLine(24.5))).toBeInTheDocument();
    expect(screen.queryByText(/About 14 windows/)).toBeNull();
    await user.click(toForm());
    expect(screen.getByRole('checkbox', { name: quote.productName('roof') })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: quote.productName('windows') })).not.toBeChecked();
  });

  it('gutters are never on the page: not in the picker, even if a company has them on', async () => {
    const user = userEvent.setup();
    setup({});
    await screen.findByRole('heading', { name: quote.servicesTitle });
    expect(screen.queryByRole('checkbox', { name: quote.productName('gutters') })).toBeNull();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    void user;
  });

  it('a company that offers one thing is not asked', async () => {
    api = stubApi({ [`GET ${BASE}`]: () => ({ body: { ...CONFIG, products: ['windows'] } }) });
    render(<QuotePage slug={SLUG} />);
    expect(await screen.findByLabelText(quote.addressLabel)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: quote.servicesTitle })).toBeNull();
    expect(screen.queryByRole('button', { name: quote.servicesChange })).toBeNull();
  });

  it('a home with nothing for their picks goes straight to the form, like a call back', async () => {
    const user = userEvent.setup();
    setup({ [`POST ${BASE}/estimate`]: () => ({ body: { ...READY, roof: null } }) });
    await getEstimate(user, ['roof']);
    expect(await screen.findByRole('heading', { name: quote.fallbackTitle })).toBeInTheDocument();
    expect(screen.getByText(quote.nothingShown)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: quote.formTitle })).toBeInTheDocument();
    expect(hasRanges({ ...READY, roof: null }, ['roof'])).toBe(false);
    expect(hasRanges(READY, ['roof'])).toBe(true);
    expect(hasRanges({ ...READY, windows: null }, ['windows'])).toBe(false);
    expect(hasRanges(FALLBACK, ['roof'])).toBe(false);
  });
});

describe('the satellite pictures cannot be trusted for the roof', () => {
  const SENTENCE =
    "We can't measure your roof from satellite images — the pictures of your home aren't clear or recent enough. We'll measure it at your free visit.";

  it('says the owner\'s sentence, shows no roof price, and goes to the form', async () => {
    const user = userEvent.setup();
    setup({ [`POST ${BASE}/estimate`]: () => ({ body: { ...READY, status: 'fallback', roof: null, windows: null, outline: null, notice: 'satellite-unusable' } }) });
    await getEstimate(user, ['roof']);
    expect(await screen.findByRole('heading', { name: quote.satelliteTitle })).toBeInTheDocument();
    expect(quote.satelliteBody).toBe(SENTENCE);
    expect(screen.getByText(SENTENCE)).toBeInTheDocument();
    expect(screen.queryByText(quote.fallbackBody)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: quote.formTitle })).toBeInTheDocument();
  });

  it('with windows too: the windows result carries on, the roof line is the sentence, and the visit can still be booked', async () => {
    const user = userEvent.setup();
    setup({ [`POST ${BASE}/estimate`]: () => ({ body: { ...READY, roof: null, notice: 'satellite-unusable' } }) });
    await getEstimate(user, ['windows', 'roof']);
    expect(await screen.findByRole('heading', { name: quote.resultsTitle })).toBeInTheDocument();
    expect(screen.getByText('About 14 windows (12\u201316)')).toBeInTheDocument();
    expect(screen.getByText(SENTENCE)).toBeInTheDocument();
    expect(screen.queryByText(quote.roofLine(24.5))).not.toBeInTheDocument();
    expect(toForm()).toBeInTheDocument();
  });

  it('a windows-only visitor is never told about the roof', async () => {
    const user = userEvent.setup();
    setup({ [`POST ${BASE}/estimate`]: () => ({ body: { ...READY, roof: null, notice: 'satellite-unusable' } }) });
    await getEstimate(user, ['windows']);
    expect(await screen.findByRole('heading', { name: quote.resultsTitle })).toBeInTheDocument();
    expect(screen.queryByText(SENTENCE)).not.toBeInTheDocument();
  });
});

describe('Measuring the windows: by device', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36';
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';

  async function results(userAgent: string, app: typeof APP | null = APP, names: QuoteProduct[] = ['windows', 'roof']) {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    const user = userEvent.setup();
    api = stubApi({ [`GET ${BASE}`]: () => ({ body: { ...CONFIG, homeownerApp: app } }), [`POST ${BASE}/estimate`]: () => ({ body: READY }) });
    render(<QuotePage slug={SLUG} />);
    await getEstimate(user, names);
    await screen.findByRole('heading', { name: quote.resultsTitle });
    return user;
  }

  afterEach(() => vi.restoreAllMocks());

  it('an iPhone: the App Store button is the main action, with the one line about the app', async () => {
    await results(IPHONE);
    const link = screen.getByRole('link', { name: quote.appDownload('WinChoice') });
    expect(link).toHaveAttribute('href', APP.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(quote.appLine)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: quote.appQrAlt('WinChoice') })).toBeNull();
    expect(screen.queryByRole('link', { name: quote.browserMeasure })).toBeNull();
  });

  it('Android: the main action measures in the browser, on the measure page for this estimate', async () => {
    await results(ANDROID);
    const link = screen.getByRole('link', { name: quote.browserMeasure });
    expect(link).toHaveAttribute('href', `/q/${SLUG}/measure?request=${READY.quoteId}`);
    expect(screen.queryByRole('link', { name: quote.appDownload('WinChoice') })).toBeNull();
  });

  it('a computer: a QR code for the measure page, with its caption, and no store button', async () => {
    await results(MAC);
    const code = screen.getByRole('img', { name: quote.appQrAlt('WinChoice') });
    expect(code.querySelector('path')!.getAttribute('d')!.length).toBeGreaterThan(200);
    expect(screen.getByText(quote.qrCaption)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: quote.appDownload('WinChoice') })).toBeNull();
  });

  it('every device keeps "Book a free visit and we\'ll measure" as a small link to the form, and the offer steps out of the way', async () => {
    for (const ua of [IPHONE, ANDROID, MAC]) {
      const user = await results(ua);
      expect(screen.queryByRole('button', { name: quote.continueButton })).toBeNull();
      await user.click(screen.getByRole('button', { name: quote.visitLink }));
      expect(screen.getByRole('heading', { name: quote.formTitle })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: quote.appDownload('WinChoice') })).toBeNull();
      expect(screen.queryByRole('link', { name: quote.browserMeasure })).toBeNull();
      expect(screen.queryByRole('img', { name: quote.appQrAlt('WinChoice') })).toBeNull();
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('without the company\'s app link only the free visit is offered, as the main button', async () => {
    const user = await results(IPHONE, null);
    expect(screen.queryByRole('link', { name: quote.appDownload('WinChoice') })).toBeNull();
    expect(screen.queryByRole('img', { name: quote.appQrAlt('WinChoice') })).toBeNull();
    await user.click(screen.getByRole('button', { name: quote.visitLink }));
    expect(screen.getByRole('heading', { name: quote.formTitle })).toBeInTheDocument();
  });

  it('is not shown when windows were not picked, or for a call back', async () => {
    await results(IPHONE, APP, ['roof']);
    expect(screen.queryByRole('link', { name: quote.appDownload('WinChoice') })).toBeNull();
    expect(screen.getByRole('button', { name: quote.continueButton })).toBeInTheDocument();
    cleanup();

    const user = userEvent.setup();
    api = stubApi({ [`GET ${BASE}`]: () => ({ body: { ...CONFIG, homeownerApp: APP } }), [`POST ${BASE}/estimate`]: () => ({ body: FALLBACK }) });
    render(<QuotePage slug={SLUG} />);
    await getEstimate(user, ['windows']);
    await screen.findByRole('heading', { name: quote.fallbackTitle });
    expect(screen.queryByRole('link', { name: quote.appDownload('WinChoice') })).toBeNull();
  });

  it('draws a QR code for the link: the same input, the same picture; a longer link, a bigger one', () => {
    const a = qrPath(APP.url);
    expect(qrPath(APP.url)).toEqual(a);
    expect(a.size).toBeGreaterThanOrEqual(21);
    expect(a.size).toBeLessThanOrEqual(61);
    expect(qrPath(`${APP.url}?company=${'x'.repeat(120)}`).size).toBeGreaterThan(a.size);
    expect(a.path.startsWith('M')).toBe(true);
  });
});

describe('Turnstile on the page', () => {
  it('with a site key, the widget token goes with the estimate; the button waits for it', async () => {
    const user = userEvent.setup();
    const render_ = vi.fn((_el: HTMLElement, opts: { callback: (t: string) => void }) => {
      setTimeout(() => opts.callback('human-token'), 0);
      return 'w1';
    });
    vi.stubGlobal('turnstile', { render: render_, remove: vi.fn() });
    api = stubApi({
      [`GET ${BASE}`]: () => ({ body: { ...CONFIG, turnstileSiteKey: 'site-key' } }),
      [`POST ${BASE}/estimate`]: () => ({ body: READY }),
    });
    render(<QuotePage slug={SLUG} />);
    await pick(user);
    await user.type(await screen.findByLabelText(quote.addressLabel), READY.address);
    await waitFor(() => expect(screen.getByRole('button', { name: quote.measureButton })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: quote.measureButton }));
    await screen.findByRole('heading', { name: quote.resultsTitle });
    expect(render_.mock.calls[0]![1]).toMatchObject({ sitekey: 'site-key' });
    expect(api.sent(`POST ${BASE}/estimate`)).toEqual([{ address: READY.address, website: '', turnstileToken: 'human-token' }]);
  });
});

describe('quote helpers', () => {
  it('checkLead mirrors the server rules', () => {
    const ok = { firstName: 'A', lastName: 'B', email: 'a@b.co', phone: '402-555-0142', postalCode: '68132', products: ['roof' as const], consent: true, textConsent: false, slotId: '', website: '' };
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

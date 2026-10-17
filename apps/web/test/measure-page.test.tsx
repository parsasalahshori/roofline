import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homeownerMeasure as copy } from '../src/copy/homeownerMeasure.ts';
import { MeasurePage } from '../src/features/quote/MeasurePage.tsx';
import { measureLink, measurePath } from '../src/features/quote/paths.ts';
import { writeSeed } from '../src/features/quote/measure/session.ts';
import { stubApi } from './helpers.tsx';
import { ADDRESS, APP, BASE, COMPANY, CREATED, QUOTE_CONFIG, QUOTE_ID, REQ, SLUG, view } from './homeowner-fixtures.ts';

/* /q/:slug/measure: which device sees what. An iPhone goes to the App Store, a computer shows a QR code, Android measures. */

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function open(userAgent: string, config = QUOTE_CONFIG) {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  window.history.replaceState({}, '', `${measurePath(SLUG)}?request=${QUOTE_ID}`);
  const api = stubApi({
    [`GET /api/public/quote/${SLUG}`]: () => ({ body: config }),
    [`GET ${BASE}/company`]: () => ({ body: COMPANY }),
    [`POST ${BASE}/requests`]: () => ({ status: 201, body: CREATED }),
    [`GET ${BASE}/requests/${REQ}`]: () => ({ body: view() }),
  });
  render(<MeasurePage slug={SLUG} />);
  return api;
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('/q/:slug/measure', () => {
  it('has a route constant and a link carrying the estimate', () => {
    expect(measurePath('summit-ridge')).toBe('/q/summit-ridge/measure');
    expect(measureLink('summit-ridge', 'abc 1')).toBe('/q/summit-ridge/measure?request=abc%201');
  });

  it('sends an iPhone to the App Store link, with a way to measure in the browser anyway', async () => {
    const api = open(IPHONE);
    const link = await screen.findByRole('link', { name: copy.iphoneButton(APP.name) });
    expect(link).toHaveAttribute('href', APP.url);
    // Nothing is created for a visitor who goes to the app
    expect(api.count(`POST ${BASE}/requests`)).toBe(0);
    writeSeed(SLUG, { quoteId: QUOTE_ID, address: ADDRESS, services: ['windows'] });
    await userEvent.setup().click(screen.getByRole('button', { name: copy.iphoneAnyway }));
    expect(await screen.findByRole('heading', { name: copy.coachTitle })).toBeInTheDocument();
    expect(api.count(`POST ${BASE}/requests`)).toBe(1);
  });

  it('lets an iPhone measure in the browser straight away when the company has no app', async () => {
    open(IPHONE, { ...QUOTE_CONFIG, homeownerApp: null });
    writeSeed(SLUG, { quoteId: QUOTE_ID, address: ADDRESS, services: ['windows'] });
    expect(await screen.findByText(copy.coachTitle)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: copy.iphoneButton(APP.name) })).toBeNull();
  });

  it('shows a computer "open this on your phone" and a QR code that carries this page and the estimate', async () => {
    const api = open(DESKTOP);
    expect(await screen.findByRole('heading', { name: copy.desktopTitle })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: copy.desktopQrAlt })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: copy.desktopBack })).toHaveAttribute('href', `/q/${SLUG}`);
    expect(api.count(`POST ${BASE}/requests`)).toBe(0);
    expect(api.count(`GET ${BASE}/company`)).toBe(0);
  });

  it('opens the measuring flow on Android from the quote page address (no second address question)', async () => {
    writeSeed(SLUG, { quoteId: QUOTE_ID, address: ADDRESS, services: ['windows'] });
    const api = open(ANDROID);
    expect(await screen.findByRole('heading', { name: copy.coachTitle })).toBeInTheDocument();
    expect(api.sent(`POST ${BASE}/requests`)).toEqual([{ address: ADDRESS, services: ['windows'] }]);
    expect(screen.getByRole('list', { name: copy.progressLabel })).toBeInTheDocument();
  });

  it('asks for the address on a phone that has no seed (it opened a QR code)', async () => {
    const api = open(ANDROID);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(copy.addressLabel), ADDRESS);
    await user.click(screen.getByRole('button', { name: copy.addressGo }));
    expect(await screen.findByRole('heading', { name: copy.coachTitle })).toBeInTheDocument();
    expect(api.sent(`POST ${BASE}/requests`)).toEqual([{ address: ADDRESS, services: ['windows'] }]);
  });

  it('says so when the page is turned off', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ANDROID);
    stubApi({ [`GET /api/public/quote/${SLUG}`]: () => ({ status: 404, body: { error: 'nope' } }) });
    render(<MeasurePage slug={SLUG} />);
    expect(await screen.findByRole('heading', { name: copy.notFoundTitle })).toBeInTheDocument();
    await waitFor(() => expect(within(document.body).queryByText(copy.coachTitle)).toBeNull());
  });
});

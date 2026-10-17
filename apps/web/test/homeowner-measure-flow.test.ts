import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeownerApiError, homeownerApi } from '../src/features/quote/measure/api.ts';
import { checkContact, flowReducer, newWindowId, roomChoices, roomCounts, screenFor, startFlow, stepOf, windowInput, zipOf, type Draft } from '../src/features/quote/measure/flow.ts';
import { createRequest, openRequest } from '../src/features/quote/measure/MeasureFlow.tsx';
import { clearStored, readSeed, readStored, writeSeed, writeStored } from '../src/features/quote/measure/session.ts';
import { ADDRESS, BASE, CREATED, QUOTE_ID, REQ, SLUG, TOKEN, WINDOW, view } from './homeowner-fixtures.ts';
import { stubApi } from './helpers.tsx';

/* The measuring flow's state (which screen, what the server says), what the browser keeps, and how a request opens or resumes. */

const draft: Draft = { id: 'w-abc', scale: { kind: 'card', cardCorners: WINDOW.scale.kind === 'card' ? WINDOW.scale.cardCorners : [[0, 0], [1, 0], [1, 1], [0, 1]], card: { widthMm: 85.6, heightMm: 53.98 } }, uploadId: 'u1', corners: [[1, 1], [9, 1], [9, 9], [1, 9]] };

describe('which screen a request opens on', () => {
  it('starts at coaching with no windows and at the list once there are some', () => {
    expect(screenFor(view())).toBe('coaching');
    expect(screenFor(view([WINDOW]))).toBe('windows');
  });
  it('sends a call-back request to coaching (which offers only the contact form)', () => {
    expect(screenFor(view([], { request: { ...view().request, status: 'callback', callbackReason: 'unit' } }))).toBe('coaching');
  });
  it('resumes a filed request at booking, or at the confirmation once a visit or a call was asked for', () => {
    const filed = { ...view([WINDOW]).request, contactFiled: true };
    expect(screenFor(view([WINDOW], { request: filed }))).toBe('book');
    expect(screenFor(view([WINDOW], { request: filed, booking: { visit: null, callMe: true } }))).toBe('booked');
  });
});

describe('the reducer', () => {
  it('goes from a measured window to naming it, then saves back to the list with the new view', () => {
    let s = startFlow(view());
    s = flowReducer(s, { type: 'go', screen: 'measure' });
    s = flowReducer(s, { type: 'measured', draft });
    expect(s.screen).toBe('describe');
    expect(s.draft).toEqual(draft);
    const next = view([WINDOW]);
    s = flowReducer(s, { type: 'saved', view: next });
    expect(s).toEqual({ screen: 'windows', view: next, draft: null });
  });
  it('drops the draft and goes back to the rooms to measure it again', () => {
    const s = flowReducer({ ...startFlow(view()), screen: 'describe', draft }, { type: 'discard' });
    expect(s.screen).toBe('rooms');
    expect(s.draft).toBeNull();
  });
  it('maps screens to the four progress steps', () => {
    expect(['rooms', 'measure', 'windows'].map((x) => stepOf(x as never))).toEqual([0, 0, 0]);
    expect([stepOf('quote'), stepOf('contact'), stepOf('book'), stepOf('booked')]).toEqual([1, 2, 3, 3]);
  });
});

describe('the window the server is sent', () => {
  it('keeps the draft id, trims the names and leaves an empty label out (never null)', () => {
    const w = windowInput(draft, '  Kitchen ', '  ', 'double-hung');
    expect(w).toEqual({ id: 'w-abc', room: 'Kitchen', style: 'double-hung', scale: draft.scale, uploadId: 'u1', corners: draft.corners });
    expect('label' in w).toBe(false);
    expect(windowInput(draft, 'Den', ' By the door ', 'picture').label).toBe('By the door');
  });
  it('makes ids the API accepts', () => {
    expect(newWindowId(() => 'AbC-123_x')).toBe('w-AbC-123_x');
    expect(newWindowId(() => 'a'.repeat(200))).toHaveLength(64);
    expect(newWindowId()).toMatch(/^w-[A-Za-z0-9_-]{1,62}$/);
  });
  it('lists the rooms already used first, then the usual ones, and counts windows per room', () => {
    expect(roomChoices(['Den', 'Kitchen']).slice(0, 4)).toEqual(['Den', 'Kitchen', 'Bedroom', 'Living room']);
    expect(roomCounts(view([WINDOW, { ...WINDOW, id: 'w2' }]))).toEqual([{ room: 'Kitchen', count: 2 }]);
  });
});

describe('the contact form checks', () => {
  const ok = { firstName: 'Dana', lastName: 'Lee', email: 'dana@example.com', phone: '(402) 555-0147', zip: '68132', consent: true };
  it('passes a good form and finds every bad field', () => {
    expect(checkContact(ok)).toEqual({});
    expect(Object.keys(checkContact({ firstName: '', lastName: ' ', email: 'x', phone: '123', zip: '6813', consent: false })).sort()).toEqual(['consent', 'email', 'firstName', 'lastName', 'phone', 'zip']);
  });
  it('takes the ZIP from the end of the address', () => {
    expect(zipOf(ADDRESS)).toBe('68132');
    expect(zipOf('Omaha, NE')).toBe('');
  });
});

describe('what the browser keeps, and opening or resuming a request', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the token in sessionStorage and localStorage, and drops one that is past its day', () => {
    writeStored(SLUG, { requestId: REQ, token: TOKEN, expiresAt: '2099-01-01T00:00:00Z', quoteId: QUOTE_ID });
    expect(window.sessionStorage.getItem(`roofline.homeowner.${SLUG}`)).toContain(TOKEN);
    expect(window.localStorage.getItem(`roofline.homeowner.${SLUG}`)).toContain(TOKEN);
    expect(readStored(SLUG)).toMatchObject({ requestId: REQ, token: TOKEN, quoteId: QUOTE_ID });
    // A new tab on the phone has only localStorage
    window.sessionStorage.clear();
    expect(readStored(SLUG)?.token).toBe(TOKEN);
    expect(readStored(SLUG, Date.parse('2100-01-01'))).toBeNull();
    clearStored(SLUG);
    expect(readStored(SLUG)).toBeNull();
  });
  it('keeps the quote page seed (quote id, address, services) and ignores a broken one', () => {
    writeSeed(SLUG, { quoteId: QUOTE_ID, address: ADDRESS, services: ['windows'] });
    expect(readSeed(SLUG)).toEqual({ quoteId: QUOTE_ID, address: ADDRESS, services: ['windows'] });
    window.sessionStorage.setItem(`roofline.homeowner.seed.${SLUG}`, '{not json');
    window.localStorage.setItem(`roofline.homeowner.seed.${SLUG}`, JSON.stringify({ quoteId: 1 }));
    expect(readSeed(SLUG)).toBeNull();
  });

  it('opens a request from the quote page address on first load, and stores its token', async () => {
    const api = stubApi({ [`POST ${BASE}/requests`]: () => ({ status: 201, body: CREATED }), [`GET ${BASE}/requests/${REQ}`]: () => ({ body: view() }) });
    writeSeed(SLUG, { quoteId: QUOTE_ID, address: ADDRESS, services: ['roof'] });
    const opened = await openRequest(SLUG, homeownerApi(SLUG), QUOTE_ID);
    expect(opened).toMatchObject({ session: { requestId: REQ, token: TOKEN } });
    // The address and services are sent in the body only; windows is always asked for
    expect(api.sent(`POST ${BASE}/requests`)).toEqual([{ address: ADDRESS, services: ['roof', 'windows'] }]);
    expect(readStored(SLUG)).toMatchObject({ requestId: REQ, token: TOKEN, quoteId: QUOTE_ID });
  });

  it('resumes the stored request on reload without creating another', async () => {
    const api = stubApi({ [`GET ${BASE}/requests/${REQ}`]: () => ({ body: view([WINDOW]) }) });
    writeStored(SLUG, { requestId: REQ, token: TOKEN, expiresAt: '2099-01-01T00:00:00Z', quoteId: QUOTE_ID });
    const opened = await openRequest(SLUG, homeownerApi(SLUG), QUOTE_ID);
    expect(opened).toMatchObject({ view: { windows: [{ id: 'w-kitchen-1' }] } });
    expect(api.count(`POST ${BASE}/requests`)).toBe(0);
  });

  it('starts a new request when the stored one is for another estimate, or the server no longer knows its token', async () => {
    const api = stubApi({
      [`GET ${BASE}/requests/${REQ}`]: () => ({ body: view() }),
      [`POST ${BASE}/requests`]: () => ({ status: 201, body: { ...CREATED, token: `${TOKEN.slice(0, 42)}Z` } }),
    });
    writeSeed(SLUG, { quoteId: QUOTE_ID, address: ADDRESS, services: ['windows'] });
    writeStored(SLUG, { requestId: REQ, token: TOKEN, expiresAt: '2099-01-01T00:00:00Z', quoteId: QUOTE_ID });
    // The first GET (the stored token) is refused; the second (after the new request) answers
    let gets = 0;
    api.routes[`GET ${BASE}/requests/${REQ}`] = () => (++gets === 1 ? { status: 401, body: { error: 'x', code: 'unauthorized' } } : { body: view() });
    const opened = await openRequest(SLUG, homeownerApi(SLUG), QUOTE_ID);
    expect(opened).toMatchObject({ session: { token: `${TOKEN.slice(0, 42)}Z` } });
    expect(api.count(`POST ${BASE}/requests`)).toBe(1);

    // A different estimate in the link: the stored request is not used
    const other = await openRequest(SLUG, homeownerApi(SLUG), 'another-quote-id');
    expect(other).toEqual({ needAddress: true });
  });

  it('asks for the address when there is no seed (the phone opened a QR code), and shows a refused address', async () => {
    stubApi({});
    expect(await openRequest(SLUG, homeownerApi(SLUG), QUOTE_ID)).toEqual({ needAddress: true });
    stubApi({ [`POST ${BASE}/requests`]: () => ({ status: 422, body: { error: "We couldn't find that address.", code: 'address_not_found', field: 'address' } }) });
    expect(await createRequest(SLUG, homeownerApi(SLUG), 'nowhere', ['windows'], null)).toEqual({ failed: "We couldn't find that address." });
    expect(new HomeownerApiError(0, 'x').status).toBe(0);
  });
});

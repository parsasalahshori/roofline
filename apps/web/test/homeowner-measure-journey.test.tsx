import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeownerRequestView } from '@roofline/shared';
import { homeownerMeasure as copy } from '../src/copy/homeownerMeasure.ts';
import { publicCopy } from '../src/copy/public.ts';
import { MeasurePage } from '../src/features/quote/MeasurePage.tsx';
import { windowPhotos } from '../src/copy/measureWindows.ts';
import { forgetArSupport } from '../src/features/measure/windows/ar/arSupport.ts';
import { measurePath } from '../src/features/quote/paths.ts';
import { writeSeed } from '../src/features/quote/measure/session.ts';
import { stubApi } from './helpers.tsx';
import { ADDRESS, BASE, COMPANY, CREATED, QUOTE_CONFIG, QUOTE_ID, REQ, SLUG, WINCHOICE_COMPANY, WINDOW, view } from './homeowner-fixtures.ts';

/*
 * The whole Android journey with the bank card (WebXR cannot run here): coaching, rooms, the photo, four card corners,
 * four window corners, the room and style, the list, the quote, the contact form, a time, the confirmation.
 */

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const SLOT = '2026-10-17T13:00:00.000Z';

let current: HomeownerRequestView;

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ANDROID);
  window.history.replaceState({}, '', `${measurePath(SLUG)}?request=${QUOTE_ID}`);
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:photo'), revokeObjectURL: vi.fn() });
  // The photo is shown 300 x 400 on screen; the server says it is 3000 x 4000 pixels
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 400, right: 300, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
  if (typeof window.PointerEvent === 'undefined') {
    class PE extends MouseEvent {
      pointerId = 1;
    }
    vi.stubGlobal('PointerEvent', PE);
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const tap = (frame: HTMLElement, x: number, y: number) => {
  fireEvent.pointerDown(frame, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  fireEvent.pointerUp(frame, { clientX: x, clientY: y, button: 0, pointerId: 1 });
};

describe('the homeowner measures a window in the browser, with a bank card', () => {
  it('goes from the first screen to a booked visit, sending what the API contract asks for', async () => {
    current = view();
    const filed = (extra: Partial<HomeownerRequestView> = {}): HomeownerRequestView => ({ ...view([WINDOW]), request: { ...view().request, contactFiled: true }, ...extra });
    const api = stubApi({
      [`GET /api/public/quote/${SLUG}`]: () => ({ body: QUOTE_CONFIG }),
      [`GET ${BASE}/company`]: () => ({ body: COMPANY }),
      [`POST ${BASE}/requests`]: () => ({ status: 201, body: CREATED }),
      [`GET ${BASE}/requests/${REQ}`]: () => ({ body: current }),
      [`POST ${BASE}/requests/${REQ}/uploads`]: () => ({ status: 201, body: { id: WINDOW.uploadId, widthPx: 3000, heightPx: 4000 } }),
      [`POST ${BASE}/requests/${REQ}/windows`]: () => {
        current = view([WINDOW]);
        return { status: 201, body: current };
      },
      [`POST ${BASE}/requests/${REQ}/contact`]: () => {
        current = filed();
        return { status: 201, body: current };
      },
      [`GET ${BASE}/requests/${REQ}/slots`]: () => ({ body: { timeZone: 'America/Chicago', slots: [{ id: SLOT, start: SLOT, end: '2026-10-17T14:00:00.000Z' }] } }),
      [`POST ${BASE}/requests/${REQ}/book`]: () => {
        current = filed({ booking: { visit: { start: SLOT, end: '2026-10-17T14:00:00.000Z', timeZone: 'America/Chicago' }, callMe: false }, status: { stage: 'visit-booked', dates: { requestedAt: '2026-10-16T21:22:11.011Z', visit: SLOT, measuredAt: null, orderedAt: null, installedAt: null }, rep: { name: 'Casey' }, timeZone: 'America/Chicago' } });
        return { body: current };
      },
    });
    writeSeed(SLUG, { quoteId: QUOTE_ID, address: ADDRESS, services: ['windows'] });
    const user = userEvent.setup();
    render(<MeasurePage slug={SLUG} />);

    // 1. coaching, 2. rooms
    await user.click(await screen.findByRole('button', { name: copy.coachStart }));
    await user.click(await screen.findByRole('button', { name: copy.roomsMeasure }));

    // 3. no WebXR here: the card. Take the photo, tap four card corners then four frame corners
    await screen.findByRole('heading', { name: copy.measureTitle });
    await user.upload(screen.getByLabelText(copy.cardPhotoLabel), new File(['jpeg'], 'w.jpg', { type: 'image/jpeg' }));
    const frame = await screen.findByRole('group', { name: copy.cardPhotoArea });
    // First the middle of the card (the view zooms to 5x there: 600 x 800 photo pixels around it), then its four corners
    expect(screen.getByText(copy.cardFind)).toBeInTheDocument();
    tap(frame, 115, 160);
    expect(await screen.findByText(copy.cardTapCard(copy.cardCornerNames[0]))).toBeInTheDocument();
    for (const [x, y] of [[75, 150], [225, 150], [225, 250], [75, 250]] as const) tap(screen.getByRole('group', { name: copy.cardPhotoArea }), x, y);
    expect(await screen.findByText(copy.cardTapFrame(copy.cardCornerNames[0]))).toBeInTheDocument();
    for (const [x, y] of [[40, 40], [260, 40], [260, 360], [40, 360]] as const) tap(screen.getByRole('group', { name: copy.cardPhotoArea }), x, y);
    await user.click(await screen.findByRole('button', { name: copy.cardUse }));

    // 4. the room and the style
    await screen.findByRole('heading', { name: copy.describeTitle });
    await user.click(screen.getByRole('radio', { name: 'Kitchen' }));
    await user.type(screen.getByLabelText(copy.describeLabel), 'Over the sink');
    // Four plain tiles with a few words under each; the bathroom question defaults to clear glass
    const tiles = within(screen.getByRole('radiogroup', { name: copy.describeStyle })).getAllByRole('radio');
    expect(tiles.map((t) => t.closest('label')!.textContent)).toEqual(['Opens up and downDouble-hung', 'Slides sidewaysSlider', "Doesn't openPicture window", 'Bay, bow or odd shapeWe quote it at your visit']);
    expect(screen.getByRole('radio', { name: copy.describeBathNo })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: /Opens up and down/ }));
    await user.click(screen.getByRole('radio', { name: copy.describeBathYes }));
    await user.click(screen.getByRole('button', { name: copy.describeSave }));

    // The photo went up as bytes; the window carries the card, its corners in photo pixels, the frame and the id
    expect(api.count(`POST ${BASE}/requests/${REQ}/uploads`)).toBe(1);
    const [sent] = api.sent(`POST ${BASE}/requests/${REQ}/windows`) as Record<string, unknown>[];
    expect(sent).toMatchObject({
      room: 'Kitchen',
      label: 'Over the sink',
      style: 'double-hung',
      frosted: true,
      uploadId: WINDOW.uploadId,
      corners: [[400, 400], [2600, 400], [2600, 3600], [400, 3600]],
      scale: { kind: 'card', cardCorners: [[1000, 1500], [1300, 1500], [1300, 1700], [1000, 1700]], card: { widthMm: 85.6, heightMm: 53.98 } },
    });
    expect(String(sent!.id)).toMatch(/^w-/);

    // 5. the list: whole inches and eighths, "about ±", a calm line for a 'check', and "Did we miss any?"
    const row = (await screen.findByText(copy.listSize(WINDOW.sizeLabel))).closest('li')!;
    expect(within(row).getByText(WINDOW.uncertaintyLabel)).toBeInTheDocument();
    expect(within(row).getByText(copy.listCheck)).toBeInTheDocument();
    expect(screen.getByText(copy.listMissing)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.listSeeQuote }));

    // 6. the quote: Good, Better, Best
    await screen.findByRole('heading', { name: copy.quoteTitle });
    for (const label of ['Good', 'Better', 'Best']) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(copy.quoteTotal('$8,750'))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.quoteContinue }));

    // 7. contact and consent (the words are the company's, as given)
    await screen.findByRole('heading', { name: copy.contactTitle });
    await user.type(screen.getByLabelText(copy.firstName), 'Dana');
    await user.type(screen.getByLabelText(copy.lastName), 'Lee');
    await user.type(screen.getByLabelText(copy.email), 'dana@example.com');
    await user.type(screen.getByLabelText(copy.phone), '(402) 555-0147');
    expect(screen.getByLabelText(copy.zip)).toHaveValue('68132');
    await user.click(screen.getByRole('button', { name: copy.send }));
    expect(await screen.findByText(copy.consentRequired)).toBeInTheDocument();
    expect(api.count(`POST ${BASE}/requests/${REQ}/contact`)).toBe(0);
    await user.click(screen.getByRole('checkbox', { name: COMPANY.consent.text }));
    await user.click(screen.getByRole('button', { name: copy.send }));
    await waitFor(() =>
      expect(api.sent(`POST ${BASE}/requests/${REQ}/contact`)).toEqual([
        { firstName: 'Dana', lastName: 'Lee', phone: '(402) 555-0147', email: 'dana@example.com', zip: '68132', contactConsent: true, textConsent: false, consentVersion: COMPANY.consent.version },
      ]),
    );

    // 8. a time, then booked
    await user.click(await screen.findByRole('radio', { name: /Oct/ }));
    await user.click(screen.getByRole('button', { name: copy.bookButton }));
    await screen.findByRole('heading', { name: copy.bookedTitle });
    expect(api.sent(`POST ${BASE}/requests/${REQ}/book`)).toEqual([{ slotStart: SLOT }]);
    expect(screen.getByText(copy.bookedRep('Casey'))).toBeInTheDocument();
    expect(api.unexpected).toEqual([]);
  });

  it('asks for a call instead when no online times are open, and resumes the same request on reload', async () => {
    current = { ...view([WINDOW]), request: { ...view().request, contactFiled: true } };
    const api = stubApi({
      [`GET /api/public/quote/${SLUG}`]: () => ({ body: QUOTE_CONFIG }),
      [`GET ${BASE}/company`]: () => ({ body: { ...COMPANY, booking: false } }),
      [`POST ${BASE}/requests`]: () => ({ status: 201, body: CREATED }),
      [`GET ${BASE}/requests/${REQ}`]: () => ({ body: current }),
      [`POST ${BASE}/requests/${REQ}/book`]: () => {
        current = { ...current, booking: { visit: null, callMe: true } };
        return { body: current };
      },
    });
    writeSeed(SLUG, { quoteId: QUOTE_ID, address: ADDRESS, services: ['windows'] });
    const user = userEvent.setup();
    const first = render(<MeasurePage slug={SLUG} />);
    await screen.findByRole('heading', { name: copy.bookTitle });
    expect(screen.getByText(copy.bookNone)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.bookCallMe }));
    await screen.findByRole('heading', { name: copy.bookedTitle });
    expect(api.sent(`POST ${BASE}/requests/${REQ}/book`)).toEqual([{ callMe: true }]);
    expect(screen.getByText(copy.bookedCall('Summit Ridge Roofing'))).toBeInTheDocument();

    // A reload (the page mounts again): the stored token resumes it at the confirmation, no second request
    first.unmount();
    render(<MeasurePage slug={SLUG} />);
    await screen.findByRole('heading', { name: copy.bookedTitle });
    expect(api.count(`POST ${BASE}/requests`)).toBe(1);
  });

  it("shows the company's own level names, notes, included list, offer, financing and the colors-and-grids line", async () => {
    current = {
      ...view([WINDOW, { ...WINDOW, id: 'w-bay', style: 'arch', styleLabel: 'Bay, bow or odd shape', frosted: true }]),
    };
    current = {
      ...current,
      quote: {
        ...current.quote!,
        atVisitCount: 1,
        tiers: current.quote!.tiers.map((t, i) => ({ ...t, label: ['Replenish', 'Refine', 'Renew'][i]!, note: ['1-year warranty', 'Lifetime warranty', 'Lifetime warranty'][i]! })),
      },
    };
    stubApi({
      [`GET /api/public/quote/${SLUG}`]: () => ({ body: QUOTE_CONFIG }),
      [`GET ${BASE}/company`]: () => ({ body: WINCHOICE_COMPANY }),
      [`POST ${BASE}/requests`]: () => ({ status: 201, body: CREATED }),
      [`GET ${BASE}/requests/${REQ}`]: () => ({ body: current }),
    });
    writeSeed(SLUG, { quoteId: QUOTE_ID, address: ADDRESS, services: ['windows'] });
    const user = userEvent.setup();
    const { container } = render(<MeasurePage slug={SLUG} />);
    // The offer banner and the trust line are on every screen
    expect(await screen.findByRole('note', { name: publicCopy.offerLabel })).toHaveTextContent('October special');
    expect(container.querySelector('[data-trust-row]')).toHaveTextContent('4.9 from 2,400+ homeowners');
    expect(container.querySelector('[data-trust-row]')).toHaveTextContent('Since 2012');
    expect(screen.getByLabelText(publicCopy.badgesLabel)).toHaveTextContent('A+ BBBMade in USALifetime warranty');
    // The list says which choice each window is and that the bathroom one is frosted
    const rows = container.querySelectorAll('[data-window-style]');
    expect(rows[0]).toHaveTextContent('Opens up and down');
    expect(rows[1]).toHaveTextContent(`Bay, bow or odd shape · ${copy.listFrosted}`);
    await user.click(await screen.findByRole('button', { name: copy.listSeeQuote }));
    await screen.findByRole('heading', { name: copy.quoteTitle });
    const cards = within(container.querySelector('[data-tiers]') as HTMLElement).getAllByRole('listitem');
    expect(cards.map((c) => c.textContent)).toEqual([
      expect.stringContaining('GoodReplenish1-year warranty'),
      expect.stringContaining('BetterRefineLifetime warranty'),
      expect.stringContaining('BestRenewLifetime warranty'),
    ]);
    expect(container.querySelector('[data-at-visit]')).toHaveTextContent(copy.quoteAtVisit(1));
    const included = container.querySelector('[data-included]') as HTMLElement;
    for (const item of WINCHOICE_COMPANY.catalog.included) expect(within(included).getByText(item)).toBeInTheDocument();
    expect(screen.getByText(publicCopy.colorsGrids)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: publicCopy.financingMore })).toHaveAttribute('href', 'https://winchoice.com/financing/');
  });

  it('measures in AR (device webxr) on a phone that supports it, with the card one tap away', async () => {
    Object.assign(navigator, { xr: { isSessionSupported: vi.fn(() => Promise.resolve(true)) } });
    forgetArSupport();
    stubApi({
      [`GET /api/public/quote/${SLUG}`]: () => ({ body: QUOTE_CONFIG }),
      [`GET ${BASE}/company`]: () => ({ body: COMPANY }),
      [`POST ${BASE}/requests`]: () => ({ status: 201, body: CREATED }),
      [`GET ${BASE}/requests/${REQ}`]: () => ({ body: view() }),
    });
    writeSeed(SLUG, { quoteId: QUOTE_ID, address: ADDRESS, services: ['windows'] });
    const user = userEvent.setup();
    try {
      render(<MeasurePage slug={SLUG} />);
      await user.click(await screen.findByRole('button', { name: copy.coachStart }));
      await user.click(await screen.findByRole('button', { name: copy.roomsMeasure }));
      expect(await screen.findByRole('button', { name: windowPhotos.arStart })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: copy.measureCardInstead }));
      expect(await screen.findByLabelText(copy.cardPhotoLabel)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: copy.measureArInstead }));
      expect(await screen.findByRole('button', { name: windowPhotos.arStart })).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(navigator, 'xr');
      forgetArSupport();
    }
  });
});

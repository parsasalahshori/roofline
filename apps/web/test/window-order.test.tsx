import {
  applyLinePatches,
  checkLine,
  DEFAULT_WINDOW_ORDER_SETTINGS,
  defaultLineOptions,
  deriveOrder,
  type MeasuredSize,
  type WindowOrderLine,
  type WindowOrderPatch,
  type WindowOrderView,
} from '@roofline/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { sizeSpeech } from '@roofline/ui';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { sizeCopy } from '../src/copy/measureWindows.ts';
import { windowOrder as copy } from '../src/copy/windowOrder.ts';
import { OrderStatusChip } from '../src/features/measure/windows/order/OrderChip.tsx';
import { OrderWindow } from '../src/features/measure/windows/order/OrderWindow.tsx';

const S = DEFAULT_WINDOW_ORDER_SETTINGS;
const m = (widthIn: number, heightIn: number, extra: Partial<MeasuredSize> = {}): MeasuredSize => ({ widthIn, heightIn, uncertaintyIn: null, quality: 'good', ...extra });

function line(id: string, over: Partial<WindowOrderLine> = {}): WindowOrderLine {
  return { id, photoWindowIds: [id], uploadId: `u-${id}`, location: id, measured: [m(36.3, 60.2)], ...defaultLineOptions(), style: 'double-hung', ...over };
}

/** Kitchen is ready (± 1/8 known), Bath has no style (error), Living's photo was unclear (check). */
const mixedLines = (): WindowOrderLine[] => [
  line('w1', { location: 'Kitchen', measured: [m(36.3, 60.2, { uncertaintyIn: { width: 0.1, height: 0.125 } })] }),
  line('w2', { location: 'Bath', style: null }),
  line('w3', { location: 'Living', measured: [m(30.2, 48.1, { quality: 'check' })] }),
];
const goodLines = (): WindowOrderLine[] => [line('w1', { location: 'Kitchen' }), line('w2', { location: 'Bath' })];

function view(lines: WindowOrderLine[], over: Partial<WindowOrderView> = {}): WindowOrderView {
  return {
    id: 'o1',
    windowMeasurementId: 'm1',
    address: '12 Elm St, Omaha, NE',
    status: 'draft',
    poNumber: '',
    lines,
    ...deriveOrder(lines, S),
    settings: S,
    mayMarkReady: true,
    readyAt: null,
    sentAt: null,
    sentBy: null,
    createdAt: '2026-10-15T00:00:00Z',
    updatedAt: '2026-10-15T00:00:00Z',
    ...over,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let current: WindowOrderView | null;
let noPhotoWindows: boolean;
let calls: { key: string; body: unknown }[];
const patches = () => calls.filter((c) => c.key === 'PATCH /api/window-orders/o1').map((c) => c.body as WindowOrderPatch);

function serve(next: WindowOrderView): Response {
  current = next;
  return json(current);
}

beforeEach(() => {
  current = view(mixedLines());
  noPhotoWindows = false;
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ key, body });
      if (key === 'GET /api/window-measurements/m1/order') return current === null ? json({ error: 'No order yet.' }, 404) : json(current);
      if (key === 'POST /api/window-measurements/m1/order') {
        if (noPhotoWindows) return json({ error: 'This address has no windows measured from on-site photos.' }, 422);
        const created = current === null;
        current = current ?? view(mixedLines());
        return json(current, created ? 201 : 200);
      }
      if (current !== null && key === 'PATCH /api/window-orders/o1') {
        const p = body as WindowOrderPatch;
        const lines = applyLinePatches(current.lines, p.lines ?? [])!;
        return serve({ ...current, ...(p.poNumber !== undefined && { poNumber: p.poNumber }), lines, ...deriveOrder(lines, S) });
      }
      if (current !== null && key === 'POST /api/window-orders/o1/ready') {
        if (!current.mayMarkReady) return json({ error: 'Owner or office marks the order ready.' }, 403);
        const lines = current.lines.map((l) => ({ ...l, lockedSize: checkLine(l, S).order }));
        return serve({ ...current, status: 'ready', lines, ...deriveOrder(lines, S), readyAt: '2026-10-15T01:00:00Z' });
      }
      if (current !== null && key === 'POST /api/window-orders/o1/reopen') {
        const lines = current.lines.map((l) => ({ ...l, lockedSize: null }));
        return serve({ ...current, status: 'draft', lines, ...deriveOrder(lines, S), readyAt: null });
      }
      return json({ error: `Unexpected ${key}` }, 500);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAt(path: string, element = <OrderWindow />) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createMemoryRouter(
    [
      { path: 'estimator/windows/:windowMeasurementId/order', element },
      { path: 'estimator/windows/:windowMeasurementId', element: <p>{'windows screen'}</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return router;
}

async function open(v: WindowOrderView | null = current) {
  current = v;
  renderAt('/estimator/windows/m1/order');
  await screen.findByRole('table', { name: copy.tableCaption });
}

const lineEl = (id: string) => document.querySelector(`tr[data-line="${id}"]`) as HTMLElement;
const orderStatus = () => screen.getByText(copy.statusLabel).parentElement!.textContent;
const markReady = () => screen.getByRole('button', { name: copy.markReady });
/** The panel beside the table: the picked window. */
const detail = () => document.querySelector('[data-detail]') as HTMLElement;
/** Picks a window by pressing its number. */
const pick = (id: string, n: number, location: string) => fireEvent.click(within(lineEl(id)).getByRole('button', { name: copy.openLine(n, location) }));
/** Opens a kit Listbox in `scope` by its label and picks an option. */
function choose(scope: HTMLElement, label: string, option: string) {
  fireEvent.click(within(scope).getByLabelText(label));
  fireEvent.click(screen.getByRole('option', { name: option }));
}
const savedState = () => document.querySelector('[data-save]')!.getAttribute('data-save');

describe('Window factory order', () => {
  it('lists the lines with the measured size (± when known), the order size and the photo-only note', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1, name: '12 Elm St' })).toBeTruthy();
    expect(screen.getByText(copy.onlyPhotoNote)).toBeTruthy();
    expect(orderStatus()).toBe(copy.statusLabel + copy.status.draft);
    expect(screen.getByRole('link', { name: copy.back }).getAttribute('href')).toBe('/estimator/windows/m1');
    // The ticket: the whole address, the PO box and how many lines
    const ticket = within(screen.getByRole('region', { name: copy.ticketLabel }));
    expect(ticket.getByText('12 Elm St, Omaha, NE')).toBeTruthy();
    expect(ticket.getByLabelText(copy.poLabel)).toBeTruthy();
    expect(ticket.getByText('3')).toBeTruthy();

    const kitchen = within(lineEl('w1'));
    // 36.3 x 60.2 to the sixteenth, ± 1/8 (the larger of the two errors)
    expect(kitchen.getByText(sizeSpeech(sizeCopy, 36.3, 60.2, 0.125, false))).toBeTruthy();
    // 36.3 - 0.1 - 1/4 = 35.95 -> 35 7/8; 60.2 - 0.125 - 1/4 = 59.825 -> 59 3/4
    expect(kitchen.getByText(sizeSpeech(sizeCopy, 35.875, 59.75, null, false))).toBeTruthy();
    expect(lineEl('w1').querySelector('[data-order-size]')).not.toBeNull();
    expect((kitchen.getByLabelText(copy.locationFor(1)) as HTMLInputElement).value).toBe('Kitchen');
    // No ± when the method cannot tell
    expect(within(lineEl('w2')).queryByText(/±/)).toBeNull();
    // The photo is in the picked window's panel
    pick('w1', 1, 'Kitchen');
    expect(within(detail()).getByRole('img').getAttribute('src')).toBe('/api/window-measurements/m1/uploads/u-w1');
  });

  it('the rule the sizes follow is written in the company’s own numbers', async () => {
    await open();
    expect(screen.getByText(copy.rule('1/4', '1/8'))).toBeTruthy();
    cleanup();
    await open(view(mixedLines(), { settings: { ...S, widthDeductionIn: 0.5, heightDeductionIn: 0.25 } }));
    expect(screen.getByText(copy.ruleSplit('1/2', '1/4', '1/8'))).toBeTruthy();
  });

  it('shows each line’s status in words; the picked line gives its reasons, errors first', async () => {
    await open();
    expect(within(lineEl('w1')).getByText(copy.lineStatusLabel(copy.lineStatus.ready))).toBeTruthy();
    expect(within(lineEl('w2')).getByText(copy.lineStatusLabel(copy.lineStatus.error))).toBeTruthy();
    expect(within(lineEl('w3')).getByText(copy.lineStatusLabel(copy.lineStatus.check))).toBeTruthy();
    // The first window that needs a look is picked: Bath has no style
    expect(detail().getAttribute('data-detail')).toBe('w2');
    expect(within(detail()).getByRole('list', { name: copy.reasonsLabel }).textContent).toContain('Pick a style.');
    expect(within(detail()).getByLabelText(copy.style).textContent).toContain(copy.pickStyle);
    // Living's photo was unclear: its reason, and the confirm box only check lines offer
    pick('w3', 3, 'Living');
    expect(within(detail()).getByText(/steep or unclear/)).toBeTruthy();
    expect(within(detail()).getByLabelText(copy.confirm)).toBeTruthy();
    pick('w1', 1, 'Kitchen');
    expect(within(detail()).queryByLabelText(copy.confirm)).toBeNull();
    expect(within(detail()).queryByRole('list', { name: copy.reasonsLabel })).toBeNull();
  });

  it('the picked row is tinted for what it needs: red for a hold, tape yellow to check, the brand colour when ready', async () => {
    await open();
    expect(lineEl('w2').getAttribute('data-tone')).toBe('bad');
    pick('w3', 3, 'Living');
    expect(lineEl('w3').getAttribute('data-tone')).toBe('tape');
    expect(lineEl('w2').hasAttribute('data-tone')).toBe(false);
    pick('w1', 1, 'Kitchen');
    expect(lineEl('w1').getAttribute('data-tone')).toBe('brand');
  });

  it('a row opens its panel when pressed anywhere but its fields', async () => {
    await open();
    fireEvent.click(within(lineEl('w3')).getByText(copy.lineStatusLabel(copy.lineStatus.check)));
    expect(detail().getAttribute('data-detail')).toBe('w3');
    // Typing in a field does not move the panel
    fireEvent.click(within(lineEl('w1')).getByLabelText(copy.locationFor(1)));
    expect(detail().getAttribute('data-detail')).toBe('w3');
  });

  it('the panel lists what each photo read and marks the smallest of each side', async () => {
    const two = [line('w1', { location: 'Kitchen', measured: [m(36.5, 60.25), m(36.25, 60.5)] })];
    await open(view(two));
    const rows = detail().querySelectorAll('[data-reading]');
    expect(rows).toHaveLength(2);
    // Photo 1 has the smaller height, photo 2 the smaller width
    expect(within(rows[0] as HTMLElement).getByText(copy.readings.smallest.height)).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(copy.readings.smallest.width)).toBeTruthy();
    expect(rows[0]!.getAttribute('data-tone')).toBe('tape');
    expect(within(detail()).getByText(copy.readings.note)).toBeTruthy();
  });

  it('a window with no photo says so in its panel', async () => {
    await open(view([line('w1', { location: 'Kitchen', uploadId: null })]));
    expect(within(detail()).getByText(copy.noPhoto)).toBeTruthy();
    expect(within(detail()).queryByRole('img')).toBeNull();
  });

  it('a picker change shows at once and saves one PATCH after the pause', async () => {
    await open();
    // Bath is picked: it has no style
    choose(detail(), copy.style, copy.styles.casement);
    choose(detail(), copy.exterior, copy.colors.bronze);
    // The status follows at once, before the save
    expect(within(lineEl('w2')).getByText(copy.lineStatusLabel(copy.lineStatus.ready))).toBeTruthy();
    expect(patches()).toHaveLength(0);
    expect(savedState()).toBe('waiting');
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual({ lines: [{ id: 'w2', style: 'casement', frameExterior: 'bronze' }] });
    await waitFor(() => expect(savedState()).toBe('saved'));
    expect(screen.getByText(copy.saved)).toBeTruthy();
  });

  it('Save draft sends what is waiting at once', async () => {
    await open();
    choose(detail(), copy.style, copy.styles.casement);
    expect(patches()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: copy.saveDraft }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual({ lines: [{ id: 'w2', style: 'casement' }] });
  });

  it('a grid needs a pattern; a one-sash style has no bottom sash', async () => {
    await open();
    pick('w1', 1, 'Kitchen');
    choose(detail(), copy.grid, copy.grids.colonial);
    expect(within(detail()).getByLabelText(copy.gridTop)).toBeTruthy();
    expect(within(detail()).getByLabelText(copy.gridBottom)).toBeTruthy();
    fireEvent.change(within(detail()).getByLabelText(copy.gridTop), { target: { value: '3x2' } });
    choose(detail(), copy.style, copy.styles.picture);
    expect(within(detail()).queryByLabelText(copy.gridBottom)).toBeNull();
    expect(within(detail()).getByLabelText(copy.gridOnly)).toBeTruthy();
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.lines![0]).toEqual({ id: 'w1', grid: { type: 'colonial', top: '3x2', bottom: '' }, style: 'picture' });
  });

  it('a yes beside a door suggests tempered glass with the code; Use tempered applies it (never automatic)', async () => {
    await open();
    pick('w1', 1, 'Kitchen');
    const kitchen = within(detail());
    const door = kitchen.getByRole('group', { name: copy.besideDoor });
    fireEvent.click(within(door).getByRole('button', { name: copy.yes }));
    expect(within(door).getByRole('button', { name: copy.yes }).getAttribute('aria-pressed')).toBe('true');
    const suggestion = kitchen.getAllByText(/IRC R308\.4\.2/);
    expect(suggestion.length).toBeGreaterThan(0);
    expect(within(lineEl('w1')).getByText(copy.lineStatusLabel(copy.lineStatus.check))).toBeTruthy();
    expect(kitchen.getByRole('switch', { name: copy.tempered }).getAttribute('aria-checked')).toBe('false');

    fireEvent.click(kitchen.getByRole('button', { name: copy.useTempered }));
    expect(kitchen.getByRole('switch', { name: copy.tempered }).getAttribute('aria-checked')).toBe('true');
    expect(kitchen.queryByRole('button', { name: copy.useTempered })).toBeNull();
    expect(kitchen.getByText(copy.temperedChosen)).toBeTruthy();
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.lines).toEqual([{ id: 'w1', safety: { besideDoor: true, wetArea: null, sillHeightIn: null, walkway: null }, tempered: true }]);
  });

  it('the sill height is saved as a number', async () => {
    await open();
    pick('w1', 1, 'Kitchen');
    fireEvent.change(within(detail()).getByLabelText(copy.sill), { target: { value: '30' } });
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.lines![0]!.safety!.sillHeightIn).toBe(30);
  });

  it('I checked this window confirms a check line', async () => {
    await open();
    pick('w3', 3, 'Living');
    fireEvent.click(within(detail()).getByLabelText(copy.confirm));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual({ lines: [{ id: 'w3', confirmed: true }] });
  });

  it('location and quantity are typed in the row', async () => {
    await open();
    fireEvent.change(within(lineEl('w1')).getByLabelText(copy.locationFor(1)), { target: { value: 'Pantry' } });
    fireEvent.change(within(lineEl('w1')).getByLabelText(copy.quantityFor(1)), { target: { value: '3' } });
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual({ lines: [{ id: 'w1', location: 'Pantry', quantity: 3 }] });
  });

  it('bulk apply sets the options on every selected line in one PATCH', async () => {
    await open();
    expect(screen.queryByRole('region', { name: copy.bulkLabel })).toBeNull();
    fireEvent.click(within(lineEl('w1')).getByLabelText(copy.selectLine(1, 'Kitchen')));
    fireEvent.click(within(lineEl('w2')).getByLabelText(copy.selectLine(2, 'Bath')));
    const barEl = screen.getByRole('region', { name: copy.bulkLabel });
    const bar = within(barEl);
    expect(bar.getByText(copy.bulkSelected(2))).toBeTruthy();
    choose(barEl, copy.style, copy.styles['slider-2']);
    choose(barEl, copy.interior, copy.colors.black);
    choose(barEl, copy.glass, copy.glasses['triple-lowe-argon']);
    choose(barEl, copy.tempered, copy.bulkTemperedYes);
    fireEvent.click(bar.getByRole('button', { name: copy.bulkApply(2) }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    const change = { style: 'slider-2', frameInterior: 'black', glass: 'triple-lowe-argon', tempered: true };
    expect(patches()[0]).toEqual({ lines: [{ id: 'w1', ...change }, { id: 'w2', ...change }] });
    // Bath is the picked window: its panel shows the new style; Living keeps its own
    expect(within(detail()).getByLabelText(copy.style).textContent).toContain(copy.styles['slider-2']);
    pick('w3', 3, 'Living');
    expect(within(detail()).getByLabelText(copy.style).textContent).toContain(copy.styles['double-hung']);
  });

  it('the select-all box in the head ticks every window', async () => {
    await open();
    fireEvent.click(screen.getByLabelText(copy.selectAll));
    expect(screen.getByText(copy.bulkSelected(3))).toBeTruthy();
    fireEvent.click(screen.getByLabelText(copy.selectAll));
    expect(screen.queryByRole('region', { name: copy.bulkLabel })).toBeNull();
  });

  it('the foot counts the windows by status and Mark ready is off, saying how many need a look', async () => {
    await open();
    const counts = within(document.querySelector('[data-counts]') as HTMLElement);
    expect(counts.getByText(copy.counts.ready(1))).toBeTruthy();
    expect(counts.getByText(copy.counts.check(1))).toBeTruthy();
    expect(counts.getByText(copy.counts.hold(1))).toBeTruthy();
    expect((markReady() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(copy.linesNeedAttention(2))).toBeTruthy();
  });

  it('a rep cannot mark ready: the button is off and says who can', async () => {
    await open(view(goodLines(), { mayMarkReady: false }));
    expect((markReady() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(copy.ownerMarksReady)).toBeTruthy();
    expect(screen.queryByRole('link', { name: copy.downloadCsv })).toBeNull();
  });

  it('owner marks it ready: sizes lock, Reopen and the CSV show; reopen goes back to draft', async () => {
    await open(view(goodLines()));
    // A draft offers only the draft PDF
    expect(screen.queryByRole('link', { name: copy.downloadCsv })).toBeNull();
    expect(screen.getByRole('link', { name: copy.draftPdf }).getAttribute('href')).toBe('/api/window-orders/o1/sheet.pdf');
    expect(screen.getByText(copy.sendNote)).toBeTruthy();
    expect((markReady() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(markReady());

    await screen.findByText(copy.readyLocked);
    expect(calls.some((c) => c.key === 'POST /api/window-orders/o1/ready')).toBe(true);
    expect(orderStatus()).toBe(copy.statusLabel + copy.status.ready);
    const csv = screen.getByRole('link', { name: copy.downloadCsv });
    expect(csv.getAttribute('href')).toBe('/api/window-orders/o1/sheet.csv');
    expect(csv.hasAttribute('download')).toBe(true);
    expect(screen.getByRole('link', { name: copy.downloadPdf }).getAttribute('href')).toBe('/api/window-orders/o1/sheet.pdf');
    expect((within(detail()).getByLabelText(copy.style) as HTMLButtonElement).disabled).toBe(true);
    expect((within(lineEl('w1')).getByLabelText(copy.locationFor(1)) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByLabelText(copy.poLabel)).toBeNull();
    expect(screen.queryByLabelText(copy.selectAll)).toBeNull();
    expect(screen.queryByRole('button', { name: copy.markReady })).toBeNull();
    expect(screen.queryByRole('button', { name: copy.saveDraft })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: copy.reopen }));
    await screen.findByRole('button', { name: copy.markReady });
    expect(orderStatus()).toBe(copy.statusLabel + copy.status.draft);
    expect((within(detail()).getByLabelText(copy.style) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a rep sees a ready order without Reopen', async () => {
    await open(view(goodLines(), { status: 'ready', mayMarkReady: false }));
    expect(screen.queryByRole('button', { name: copy.reopen })).toBeNull();
    expect(screen.getByRole('link', { name: copy.downloadCsv })).toBeTruthy();
  });

  it('shows the totals and the grouped sheet preview', async () => {
    await open(view(goodLines()));
    const totals = document.querySelector('[data-totals]') as HTMLElement;
    // Two identical double-hung windows: one sheet line, quantity 2
    expect(within(totals).getByText(copy.totals.windows).nextElementSibling!.textContent).toBe('2');
    expect(within(totals).getByText(copy.totals.lines).nextElementSibling!.textContent).toBe('1');
    const row = document.querySelector('[data-group="1"]') as HTMLElement;
    expect(row.textContent).toContain('Kitchen, Bath');
    expect(within(row).getByText(sizeSpeech(sizeCopy, 36, 59.875, null, false))).toBeTruthy();
    expect(row.textContent).toContain(copy.glasses['lowe-argon']);
  });

  it('the spec column says the colours once when every window has the same', async () => {
    await open(view(goodLines()));
    expect(screen.getByText(copy.allColors('White', 'White'))).toBeTruthy();
    cleanup();
    await open(view([line('w1', { location: 'Kitchen' }), line('w2', { location: 'Bath', frameExterior: 'bronze' })]));
    expect(screen.queryByText(copy.allColors('White', 'White'))).toBeNull();
    expect(within(lineEl('w2')).getByText(copy.colorsSlash('Bronze', 'White'), { exact: false })).toBeTruthy();
  });

  it('the PO number saves after the pause', async () => {
    await open();
    fireEvent.change(screen.getByLabelText(copy.poLabel), { target: { value: 'PO-77' } });
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toEqual({ poNumber: 'PO-77' });
  });

  it('makes the order when the measurement has none yet (404, then POST)', async () => {
    current = null;
    renderAt('/estimator/windows/m1/order');
    await screen.findByText(copy.preparing);
    await screen.findByRole('table', { name: copy.tableCaption });
    expect(calls.map((c) => c.key)).toEqual(['GET /api/window-measurements/m1/order', 'POST /api/window-measurements/m1/order']);
  });

  it('says why when the measurement has no photo windows (422) and links back', async () => {
    current = null;
    noPhotoWindows = true;
    renderAt('/estimator/windows/m1/order');
    await screen.findByText(copy.noPhotoWindowsTitle);
    expect(screen.getByText('This address has no windows measured from on-site photos.')).toBeTruthy();
    const back = screen.getAllByRole('link', { name: copy.back });
    expect(back.every((a) => a.getAttribute('href') === '/estimator/windows/m1')).toBe(true);
  });
});

describe('OrderStatusChip', () => {
  const chipAt = () => renderAt('/estimator/windows/m1/order', <OrderStatusChip measurementId="m1" />);

  it('offers Create factory order when there is none', async () => {
    current = null;
    chipAt();
    const link = await screen.findByRole('link', { name: copy.createOrder });
    expect(link.getAttribute('href')).toBe('/estimator/windows/m1/order');
  });

  it('shows the order’s status and links to it', async () => {
    current = view(goodLines(), { status: 'ready' });
    chipAt();
    const link = await screen.findByRole('link', { name: copy.chip(copy.status.ready) });
    expect(link.getAttribute('href')).toBe('/estimator/windows/m1/order');
  });

  it('without photo windows shows nothing and does not ask for an order', async () => {
    current = view(goodLines(), { status: 'ready' });
    renderAt('/estimator/windows/m1/order', <OrderStatusChip measurementId="m1" hasPhotoWindows={false} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

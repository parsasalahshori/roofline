import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router';
import { computeScanResult, type ScanDetailView, type ScanFrame, type ScanMark, type ScanQueueView, scanResultOf, type ScanStatus, type ScanWall } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { scanReview } from '../src/copy/scanReview.ts';
import badMark from '../../../packages/shared/test/fixtures/window-scan/bad-mark.json';
import { ACCOUNT, type Routes, SHELL_ROUTES, stubApi } from './helpers.tsx';

vi.mock('../src/shell/map/MapView.tsx', () => ({ MapView: () => null }));

let api: ReturnType<typeof stubApi>;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

const fixture = badMark as unknown as { input: { frames: ScanFrame[]; marks: ScanMark[]; wall: ScanWall } };
const NOW = Date.now();

function item(over: Partial<ScanQueueView['scans'][number]> = {}): ScanQueueView['scans'][number] {
  return {
    id: 's1',
    status: 'needs_review',
    expedite: false,
    slaDueAt: new Date(NOW + 5 * 3600_000 + 120_000).toISOString(),
    secondsLeft: 5 * 3600 + 120,
    overdue: false,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    windowId: 'w1',
    room: 'Kitchen',
    label: 'Sink window',
    address: '4810 Underwood Ave, Omaha, NE',
    homeowner: 'Dana Whitfield',
    frameCount: 9,
    thumbUrl: '/api/window-scans/s1/frames/r1/image',
    widthIn: 34.7,
    heightIn: 55.8,
    failed: ['reprojection'],
    outcome: null,
    ...over,
  };
}

const COUNTS = { processing: 0, measured: 1, needs_review: 2, in_review: 0, junior_done: 1, visit_required: 0 };

function detail(status: ScanStatus, over: Partial<ScanDetailView> = {}): ScanDetailView {
  const frames = fixture.input.frames.map((f) => ({ ...f, imageUrl: `/api/window-scans/s1/frames/${f.frameId}/image` }));
  const result = scanResultOf(computeScanResult(frames, fixture.input.marks, fixture.input.wall));
  return {
    id: 's1',
    status,
    expedite: false,
    slaDueAt: new Date(NOW + 5 * 3600_000).toISOString(),
    secondsLeft: 5 * 3600,
    overdue: false,
    createdAt: new Date(NOW).toISOString(),
    windowId: 'w1',
    room: 'Kitchen',
    label: 'Sink window',
    address: '4810 Underwood Ave, Omaha, NE',
    homeowner: 'Dana Whitfield',
    app: '0.1.0',
    device: 'iPhone17,2',
    frames,
    marks: fixture.input.marks,
    marksOriginal: fixture.input.marks,
    wall: fixture.input.wall,
    phoneResult: result,
    result,
    junior: status === 'junior_done' ? { id: 'u1', name: 'Pat Rivera', at: new Date(NOW).toISOString() } : null,
    senior: null,
    outcome: null,
    outcomeReason: null,
    overrode: false,
    history: [{ at: new Date(NOW).toISOString(), by: null, action: 'created', byName: null }],
    mayEdit: status !== 'junior_done',
    mayFinalize: status === 'junior_done',
    ...over,
  };
}

function render_(path: string, routes: Routes) {
  api = stubApi({ ...SHELL_ROUTES, 'GET /api/auth/me': () => ({ body: ACCOUNT }), ...routes });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: [path] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, user: userEvent.setup() };
}

describe('Scan review queue', () => {
  it('lists the scans with their room, homeowner, status, time left and why they need a person; each row opens the scan', async () => {
    render_('/scans', {
      'GET /api/window-scans?status=needs_review,in_review': () => ({
        body: { scans: [item(), item({ id: 's2', room: 'Den', label: 'Window A', status: 'in_review', expedite: true, failed: ['sym_ratio', 'plane'], homeowner: null })], counts: COUNTS } satisfies ScanQueueView,
      }),
    });
    const list = await screen.findByRole('list', { name: scanReview.queueLabel });
    const rows = within(list).getAllByRole('link');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute('href')).toBe('/scans/s1');
    expect(within(rows[0]!).getByText(/Kitchen\s+·\s+Sink window/)).toBeTruthy();
    expect(within(rows[0]!).getByText(scanReview.status.needs_review)).toBeTruthy();
    expect(within(rows[0]!).getByText(/^5h \d+m left$/)).toBeTruthy();
    expect(within(rows[0]!).getByText(scanReview.failedShort.reprojection)).toBeTruthy();
    // An expedited scan says so instead of counting down
    expect(within(rows[1]!).getByText(scanReview.expedited)).toBeTruthy();
    expect(within(rows[1]!).getByText(`${scanReview.failedShort.sym_ratio} · ${scanReview.failedShort.plane}`)).toBeTruthy();
    expect(within(rows[1]!).getByText(new RegExp(scanReview.homeownerUnknown))).toBeTruthy();
  });

  it('shows the count in each filter, turns a passed deadline red, and asks again when the filter changes', async () => {
    const { user } = render_('/scans', {
      'GET /api/window-scans?status=needs_review,in_review': () => ({ body: { scans: [item({ slaDueAt: new Date(NOW - 3 * 3600_000).toISOString(), secondsLeft: -3 * 3600, overdue: true })], counts: COUNTS } }),
      'GET /api/window-scans?status=junior_done': () => ({ body: { scans: [], counts: COUNTS } }),
    });
    const group = await screen.findByRole('radiogroup', { name: scanReview.filterLabel });
    expect(await within(group).findByRole('radio', { name: new RegExp(`^${scanReview.filters.todo}\\s*2`) })).toBeTruthy();
    expect(within(group).getByRole('radio', { name: new RegExp(`^${scanReview.filters.senior}\\s*1`) })).toBeTruthy();
    expect(await screen.findByText(/^Overdue 3h/)).toBeTruthy();
    await user.click(within(group).getByRole('radio', { name: new RegExp(`^${scanReview.filters.senior}`) }));
    expect(await screen.findByText(scanReview.emptyTitle.senior)).toBeTruthy();
  });
});

describe('Scan review screen', () => {
  it('shows the frames, the size the marks give, each quality check and the way to hand it to a senior reviewer', async () => {
    const view = detail('needs_review');
    const { user } = render_('/scans/s1', {
      'GET /api/window-scans/s1': () => ({ body: view }),
      'POST /api/window-scans/s1/submit': () => ({ body: { ...view, status: 'junior_done', mayEdit: false } }),
    });
    expect(await screen.findByRole('heading', { name: /Kitchen\s+·\s+Sink window/ })).toBeTruthy();
    // 5 regular frames and 4 close-ups, each a way into the frame
    expect(screen.getAllByRole('link', { name: /^Open Frame \d$/ })).toHaveLength(5);
    expect(screen.getAllByRole('link', { name: /^Open Close-up, / })).toHaveLength(4);
    // The inspector: size and the failing check
    const inspector = screen.getByRole('complementary', { name: scanReview.title });
    expect(within(inspector).getByText(/^34 \d\/\d × 55 \d\/\d$/)).toBeTruthy();
    const checks = within(inspector).getByRole('region', { name: scanReview.checksTitle });
    expect(within(checks).getAllByText(scanReview.checkPass).length).toBeGreaterThanOrEqual(4);
    expect(within(checks).getByText(scanReview.checkFail)).toBeTruthy();
    await user.click(within(inspector).getByRole('button', { name: scanReview.submit }));
    await waitFor(() => expect(api.count('POST /api/window-scans/s1/submit')).toBe(1));
  });

  it('a frame opens in the editor (its marks are buttons you can move), with the corners to place and a way back', async () => {
    const view = detail('needs_review');
    const { router, user } = render_('/scans/s1?frame=r2', { 'GET /api/window-scans/s1': () => ({ body: view }) });
    expect(await screen.findByRole('group', { name: scanReview.pickCorner })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /mark on Frame 2$/ })).toHaveLength(4);
    await user.click(screen.getByRole('button', { name: scanReview.viewerBack }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(await screen.findByRole('link', { name: 'Open Frame 2' })).toBeTruthy();
  });

  it('a senior reviewer needs a written reason to call a failing scan measured, and to send a window to a visit; then the call is made', async () => {
    const view = detail('junior_done');
    const { user } = render_('/scans/s1', {
      'GET /api/window-scans/s1': () => ({ body: view }),
      'POST /api/window-scans/s1/finalize': ({ body }) => ({ body: { ...view, status: (body as { outcome: ScanStatus }).outcome, mayFinalize: false } }),
    });
    const measured = await screen.findByRole('button', { name: scanReview.measured });
    const visit = screen.getByRole('button', { name: scanReview.visitRequired });
    expect((measured as HTMLButtonElement).disabled).toBe(true);
    expect((visit as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText(scanReview.reasonLabel), 'Close-up looks right to me');
    expect((measured as HTMLButtonElement).disabled).toBe(false);
    await user.click(measured);
    await waitFor(() => expect(api.sent('POST /api/window-scans/s1/finalize')).toEqual([{ outcome: 'measured', reason: 'Close-up looks right to me', override: true }]));
  });

  it('a reviewer who is not senior sees that a senior reviewer finalises, and no finalise buttons', async () => {
    const view = detail('junior_done', { mayFinalize: false });
    render_('/scans/s1', { 'GET /api/window-scans/s1': () => ({ body: view }) });
    expect(await screen.findByText(new RegExp(scanReview.waitingSenior))).toBeTruthy();
    expect(screen.queryByRole('button', { name: scanReview.measured })).toBeNull();
  });

  it('a finished scan shows how it ended and nothing to press', async () => {
    const view = detail('visit_required', { outcome: 'visit_required', outcomeReason: 'Bay window', mayEdit: false, mayFinalize: false });
    render_('/scans/s1', { 'GET /api/window-scans/s1': () => ({ body: view }) });
    expect(await screen.findByText(scanReview.outcomeVisit)).toBeTruthy();
    expect(screen.getByText(scanReview.outcomeReason('Bay window'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: scanReview.submit })).toBeNull();
  });

  it('a scan that is not found says so', async () => {
    render_('/scans/nope', { 'GET /api/window-scans/nope': () => ({ status: 404, body: { error: 'We could not find that.' } }) });
    expect(await screen.findByText(scanReview.notFound)).toBeTruthy();
  });
});

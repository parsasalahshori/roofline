import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router';
import { computeScanResult, type ScanDetailView, type ScanFrame, type ScanMark, type ScanQueueView, type ScanRefineView, scanResultOf, type ScanStatus, type ScanWall, windowSizeLabel } from '@roofline/shared';
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

/* -- the server's refinement ------------------------------------------------------------------------------------------- */

const AI_MARKS: ScanMark[] = fixture.input.marks.filter((m) => m.frameId === 'r1' || m.frameId === 'r2').map((m) => ({ ...m, x: m.x + 2, y: m.y - 1, source: 'ai' as const }));

function refinement(over: Partial<ScanRefineView> = {}): ScanRefineView {
  return {
    version: 1,
    state: 'done',
    trigger: 'upload',
    requestedAt: new Date(NOW).toISOString(),
    startedAt: new Date(NOW).toISOString(),
    finishedAt: new Date(NOW + 14_000).toISOString(),
    attempt: 1,
    error: null,
    poseSource: 'colmap',
    poseNote: null,
    colmap: { ran: true, used: true, registered: 9, total: 9, alignmentRmsCm: 0.4, alignmentMaxCm: 0.6, rotationRmsDeg: 0.1, scale: 0.41, method: 'centres', points: 7888, meanReprojPx: 0.16, reason: null, ms: { extract: 5100, match: 450, map: 960, align: 15 } },
    frames: fixture.input.frames.map((f) => ({
      frameId: f.frameId,
      state: f.kind === 'closeup' ? ('no_quad' as const) : ('ok' as const),
      quality: f.kind === 'closeup' ? null : 0.93,
      maskScore: 0.95,
      box: [100, 100, 900, 1200] as [number, number, number, number],
      prompt: 'projected' as const,
      marks: f.kind === 'closeup' ? 0 : 4,
      ms: 900,
      note: f.kind === 'closeup' ? 'The mask has no four-sided shape (the window may run off the picture).' : null,
      maskUrl: `/api/window-scans/s1/frames/${f.frameId}/mask`,
    })),
    aiMarks: AI_MARKS,
    alternatives: [{ frameId: 'r2', corner: 1, x: 700, y: 300, source: 'snap' }],
    dropped: [{ frameId: 'r3', corner: 2, x: 1200, y: 900, source: 'ai' }],
    cloudPoints: 3,
    timings: { totalMs: 14_200, aiMs: 8_000, colmapMs: 13_000 },
    firstWidthIn: 34.7219,
    firstHeightIn: 55.8059,
    cloudUrl: '/api/window-scans/s1/refinement/cloud',
    ...over,
  };
}

function refined(status: ScanStatus, r: ScanRefineView | null, over: Partial<ScanDetailView> = {}): ScanDetailView {
  const base = detail(status);
  const frames = base.frames.map((f) => ({ ...f, poseSource: r?.poseSource ?? undefined, ai: r?.frames.find((a) => a.frameId === f.frameId) }));
  const result = r === null ? base.result : { ...base.result, refined: { poseSource: r.poseSource ?? ('arkit' as const), colmapFrames: r.poseSource === 'colmap' ? 9 : 0, frames: 9, alignmentRmsCm: 0.4, aiFrames: 5, aiMarks: 10, marksUsed: 24, marksDropped: 1, firstWidthIn: 34.72, firstHeightIn: 55.8 } };
  return { ...base, frames, result, refinement: r, mayRefine: r !== null && r.state !== 'queued' && r.state !== 'running', ...over };
}

const CLOUD = { count: 3, points: [[0, 1.4, 0, 180, 80, 60], [0.5, 1.2, 0.02, 190, 90, 70], [-0.4, 1.6, -0.1, 200, 100, 80]] };

describe('Scan review screen: the server\u2019s refinement', () => {
  it('says it was refined with COLMAP and by how much the cameras agree, what the AI did, the size before and after, and runs it again on request', async () => {
    const view = refined('needs_review', refinement());
    const { user } = render_('/scans/s1', {
      'GET /api/window-scans/s1': () => ({ body: view }),
      'GET /api/window-scans/s1/refinement/cloud': () => ({ body: CLOUD }),
      'POST /api/window-scans/s1/refine': () => ({ body: refined('needs_review', refinement({ state: 'queued' })) }),
    });
    const panel = await screen.findByRole('region', { name: scanReview.refineTitle });
    expect(within(panel).getByText(scanReview.refineColmap)).toBeTruthy();
    expect(within(panel).getByText(scanReview.refineColmapBody(9, 9, 0.4))).toBeTruthy();
    expect(within(panel).getByText(scanReview.aiBody(5, 9))).toBeTruthy();
    expect(within(panel).getByText(scanReview.aiMarks(2 * 4))).toBeTruthy();
    expect(within(panel).getByText(scanReview.refineSizeBefore(windowSizeLabel(34.7219, 55.8059).replace(' x ', ' × ')))).toBeTruthy();
    expect(within(panel).getByText(scanReview.refineMarksBody(1, 1))).toBeTruthy();
    expect(within(panel).getByText(scanReview.refineTook(14.2))).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: scanReview.refineRerun }));
    await waitFor(() => expect(api.count('POST /api/window-scans/s1/refine')).toBe(1));
  });

  it('keeps the phone\u2019s poses and says why', async () => {
    const view = refined('needs_review', refinement({ poseSource: 'arkit', poseNote: 'COLMAP registered only 3 of 9 photos (needs 4).', colmap: { ...refinement().colmap!, used: false, registered: 3 } }));
    render_('/scans/s1', { 'GET /api/window-scans/s1': () => ({ body: view }), 'GET /api/window-scans/s1/refinement/cloud': () => ({ body: CLOUD }) });
    const panel = await screen.findByRole('region', { name: scanReview.refineTitle });
    expect(within(panel).getByText(scanReview.refineArkit)).toBeTruthy();
    expect(within(panel).getByText('COLMAP registered only 3 of 9 photos (needs 4).')).toBeTruthy();
  });

  it('a scan being refined says so, has no re-run button, and a failed refinement says the phone\u2019s result stands', async () => {
    const waiting = refined('processing', refinement({ state: 'running', finishedAt: null, cloudUrl: null }), { mayEdit: false });
    const first = render_('/scans/s1', { 'GET /api/window-scans/s1': () => ({ body: waiting }) });
    const panel = await screen.findByRole('region', { name: scanReview.refineTitle });
    expect(within(panel).getByText(scanReview.refineRunning)).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: scanReview.refineRerun })).toBeNull();
    expect(screen.getByText(scanReview.status.processing)).toBeTruthy();
    first.router.dispose();
    cleanup();
    const failed = refined('needs_review', refinement({ state: 'failed', error: 'COLMAP ran longer than 900 seconds.', cloudUrl: null }));
    render_('/scans/s1', { 'GET /api/window-scans/s1': () => ({ body: failed }) });
    const again = await screen.findByRole('region', { name: scanReview.refineTitle });
    expect(within(again).getByText(scanReview.refineFailedBody('COLMAP ran longer than 900 seconds.'))).toBeTruthy();
    expect(within(again).getByRole('button', { name: scanReview.refineRerun })).toBeTruthy();
  });

  it('a scan that was never refined has no refinement card, and no 3D section', async () => {
    render_('/scans/s1', { 'GET /api/window-scans/s1': () => ({ body: detail('needs_review') }) });
    await screen.findByRole('heading', { name: /Kitchen\s+·\s+Sink window/ });
    expect(screen.queryByRole('region', { name: scanReview.refineTitle })).toBeNull();
    expect(screen.queryByRole('region', { name: scanReview.cloudTitle })).toBeNull();
  });

  it('the grid shows the AI masks on the frames, with a switch for all of them, and the 3D rebuild as two scatters', async () => {
    const view = refined('needs_review', refinement());
    const { user } = render_('/scans/s1', { 'GET /api/window-scans/s1': () => ({ body: view }), 'GET /api/window-scans/s1/refinement/cloud': () => ({ body: CLOUD }) });
    const toggle = await screen.findByRole('switch', { name: scanReview.maskLabelAll });
    expect(document.querySelectorAll('image[data-glyph="mask"]')).toHaveLength(9);
    await user.click(toggle);
    expect(document.querySelectorAll('image[data-glyph="mask"]')).toHaveLength(0);
    const cloud = await screen.findByRole('region', { name: scanReview.cloudTitle });
    expect(await within(cloud).findByRole('img', { name: scanReview.cloudLabel(scanReview.cloudTop) })).toBeTruthy();
    expect(within(cloud).getByRole('img', { name: scanReview.cloudLabel(scanReview.cloudSide) })).toBeTruthy();
    // 3 points in each, a diamond for each of the four corners, a square for each of the nine cameras
    const top = within(cloud).getByRole('img', { name: scanReview.cloudLabel(scanReview.cloudTop) });
    expect(top.querySelectorAll('circle')).toHaveLength(3);
    expect(top.querySelectorAll('rect')).toHaveLength(9);
  });

  it('a frame shows the AI\u2019s marks as squares apart from the rings, a mask switch, and the candidates that lost and the marks thrown out on request', async () => {
    // on frame 2 the phone's marks are all source ai (the fixture's); the reviewer has moved the top left one
    const marks = fixture.input.marks.map((m) => (m.frameId === 'r2' && m.corner === 0 ? { ...m, source: 'user' as const } : m));
    const view = { ...refined('needs_review', refinement()), marks };
    const { user } = render_('/scans/s1?frame=r2', { 'GET /api/window-scans/s1': () => ({ body: view }) });
    expect(await screen.findByRole('group', { name: scanReview.pickCorner })).toBeTruthy();
    expect(document.querySelectorAll('rect[data-glyph="ai"]')).toHaveLength(3);
    expect(document.querySelectorAll('circle[data-glyph="ring"]')).toHaveLength(1);
    expect(screen.getByTestId('frame-ai').textContent).toContain(scanReview.aiState.ok);
    expect(screen.getByTestId('frame-ai').textContent).toContain(scanReview.poseColmap);
    // the mask switch
    expect(document.querySelectorAll('image[data-glyph="mask"]')).toHaveLength(1);
    await user.click(screen.getByRole('switch', { name: scanReview.maskLabel }));
    expect(document.querySelectorAll('image[data-glyph="mask"]')).toHaveLength(0);
    // the candidate that lost on this frame, only when asked for
    expect(document.querySelectorAll('circle[data-glyph="alt"]')).toHaveLength(0);
    await user.click(screen.getByRole('switch', { name: scanReview.candidatesLabel }));
    expect(document.querySelectorAll('circle[data-glyph="alt"]')).toHaveLength(1);
    expect(screen.getByText(scanReview.legendCandidate)).toBeTruthy();
    expect(screen.getByText(scanReview.legendAi)).toBeTruthy();
  });

  it('the mark thrown out shows as a cross on its own frame only', async () => {
    const view = refined('needs_review', refinement());
    const { user } = render_('/scans/s1?frame=r3', { 'GET /api/window-scans/s1': () => ({ body: view }) });
    expect(await screen.findByRole('group', { name: scanReview.pickCorner })).toBeTruthy();
    await user.click(screen.getByRole('switch', { name: scanReview.candidatesLabel }));
    expect(document.querySelectorAll('path[data-glyph="dropped"]')).toHaveLength(1);
    expect(document.querySelectorAll('circle[data-glyph="alt"]')).toHaveLength(0);
  });

  it('the editor still works on a refined scan: every corner can be picked', async () => {
    const view = refined('needs_review', refinement());
    render_('/scans/s1?frame=r2', { 'GET /api/window-scans/s1': () => ({ body: view }) });
    expect(await screen.findByRole('group', { name: scanReview.pickCorner })).toBeTruthy();
    // the editor still works on a refined scan: every corner can be picked
    expect(screen.getAllByRole('button', { name: /mark on Frame 2$/ })).toHaveLength(4);
  });
});

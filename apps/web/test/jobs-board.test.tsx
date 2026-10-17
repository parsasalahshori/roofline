import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOARD_STAGES, localDate, type BoardColumn, type BoardStage, type BoardView, type JobCard, type JobStage } from '@roofline/shared';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { jobs } from '../src/copy/jobs.ts';
import { ACCOUNT, type Routes, SHELL_ROUTES, stubApi, where } from './helpers.tsx';

// Phone and desktop differ only in the layout; the phone test flips this flag.
const phoneMode = vi.hoisted(() => ({ phone: false }));
vi.mock('../src/shell/useIsPhone.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/shell/useIsPhone.ts')>()),
  useIsPhone: () => phoneMode.phone,
}));

// The real map loads maplibre-gl, which these tests never need.
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return {
    MapView: () => createElement('div', { 'data-map-mock': true }),
  };
});

let api: ReturnType<typeof stubApi>;
/** What `GET /api/jobs/board` answers right now. A PATCH may replace it. */
let current: BoardView;
/** How many proposals the server says are sent, and how many of those the customer has opened. */
let waiting = { sent: 0, viewed: 0 };
/** While set, every PATCH waits for it before it reaches the stub. */
let heldPatch: Promise<void> | null = null;
/** The bodies of every PATCH, recorded the moment it is sent (held or not). */
let patchBodies: unknown[] = [];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  heldPatch = null;
  patchBodies = [];
  waiting = { sent: 0, viewed: 0 };
  phoneMode.phone = false;
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A job card as the board sends it. Pass what differs. */
function job(overrides: Partial<JobCard> & { id: string; stage: JobStage }): JobCard {
  return {
    customerId: 'c1',
    customerName: 'Pat Homeowner',
    propertyId: 'p1',
    addressLine: '12 Oak St',
    valueCents: null,
    assigned: null,
    daysInStage: 2,
    stuck: false,
    nextStep: null,
    nextStepOn: null,
    updatedAt: '2026-10-10T12:00:00.000Z',
    ...overrides,
  };
}

/** One column. The count is the number of jobs given unless `count` says otherwise. */
function column(stage: BoardStage, jobs: JobCard[] = [], totalCents: number | null = null): BoardColumn {
  return { stage, count: jobs.length, totalCents, jobs };
}

/** A whole board: every stage (empty unless given), and the Lost count. */
function boardOf(columns: BoardColumn[] = [], lost = 0): BoardView {
  const byStage = new Map(columns.map((col) => [col.stage, col]));
  return {
    columns: BOARD_STAGES.map((stage) => byStage.get(stage) ?? column(stage)),
    lost: { count: lost },
  };
}

/** A signed-in owner whose board answers from `current`. Pass what the test sends or expects. */
function signedIn(board: BoardView, overrides: Routes = {}) {
  current = board;
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: ACCOUNT }),
    'GET /api/team': () => ({ body: { members: [] } }),
    'GET /api/jobs/board': () => ({ body: current }),
    // The Jobs head counts proposals waiting on a signature: the sent ones and the opened ones
    'GET /api/proposals?status=sent': () => ({ body: { proposals: [], total: waiting.sent } }),
    'GET /api/proposals?status=viewed': () => ({ body: { proposals: [], total: waiting.viewed } }),
    ...overrides,
  });
  return api;
}

/**
 * Holds every PATCH until the returned `release` is called. The PATCH is recorded when sent, so
 * a test can see the request before the answer comes back. Call after `signedIn`.
 */
function holdPatches() {
  let release!: () => void;
  heldPatch = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stubbed = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') patchBodies.push(JSON.parse(String(init.body)));
      if (init?.method === 'PATCH' && heldPatch !== null) return heldPatch.then(() => stubbed(input, init));
      return stubbed(input, init);
    },
  );
  return release;
}

/** Records the PATCH bodies the way `holdPatches` does, without holding them. */
function recordPatches() {
  const stubbed = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') patchBodies.push(JSON.parse(String(init.body)));
      return stubbed(input, init);
    },
  );
}

function renderApp(path: string) {
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

const board = () => screen.findByRole('region', { name: jobs.boardLabel });
const stageRegion = (stage: BoardStage) => screen.findByRole('region', { name: jobs.stage[stage] });
/** The card (its link and Move-to menu) for a customer, found through the link. */
const cardFor = (customer: string) => screen.getByRole('link', { name: new RegExp(customer) }).parentElement as HTMLElement;
const moveButton = (customer: string) => within(cardFor(customer)).getByRole('button', { name: jobs.moveTo });
/** Opens a card's Move to… menu and returns its listbox. */
async function openMove(user: ReturnType<typeof userEvent.setup>, customer: string) {
  await user.click(moveButton(customer));
  return screen.findByRole('listbox', { name: jobs.moveHeading(customer) });
}
/** Moves a card through its menu: open it, click the stage. */
async function moveTo(user: ReturnType<typeof userEvent.setup>, customer: string, stage: string) {
  const list = await openMove(user, customer);
  await user.click(within(list).getByRole('option', { name: stage }));
}

describe('pipeline board', () => {
  it('columns and counts from a stubbed BoardView', async () => {
    signedIn(
      boardOf(
        [
          column('lead', [job({ id: 'j1', stage: 'lead' }), job({ id: 'j2', stage: 'lead', customerName: 'Sam Two' })]),
          column('inspection', [job({ id: 'j3', stage: 'inspection', customerName: 'Lee Three' })]),
        ],
        1,
      ),
    );
    renderApp('/jobs');

    const pipeline = await board();
    await waitFor(() => expect(within(pipeline).getAllByRole('region')).toHaveLength(5));
    expect(within(pipeline).getByRole('heading', { name: jobs.columnHeader(jobs.stage.lead, 2) })).toBeInTheDocument();
    expect(within(pipeline).getByRole('heading', { name: jobs.columnHeader(jobs.stage.inspection, 1) })).toBeInTheDocument();
    expect(within(pipeline).getByRole('heading', { name: jobs.columnHeader(jobs.stage.won, 0) })).toBeInTheDocument();
    expect(within(pipeline).getByRole('button', { name: jobs.lostDrawer(1) })).toBeInTheDocument();
  });

  it('totals shown for owner, hidden when null', async () => {
    signedIn(
      boardOf([
        column('lead', [job({ id: 'j1', stage: 'lead', valueCents: 1250000 })], 1250000),
        column('inspection', [job({ id: 'j2', stage: 'inspection', customerName: 'Lee Three' })], null),
      ]),
    );
    renderApp('/jobs');

    const lead = await stageRegion('lead');
    // The page shows the money; the word "total" is there for a screen reader
    expect(lead.querySelector('[data-part="lane-total"]')).toHaveTextContent(jobs.total('$12,500'));
    const inspection = await stageRegion('inspection');
    expect(inspection.querySelector('[data-part="lane-total"]')).toBeNull();
  });

  it('a lane with jobs but no value says "No value yet", not $0', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })], 0)]));
    renderApp('/jobs');

    const lead = await stageRegion('lead');
    expect(lead.querySelector('[data-part="lane-total"]')).toHaveTextContent(jobs.noValueYet);
    expect(lead).not.toHaveTextContent('$0');
  });

  it('drag a card from Lead to Inspection moves it before the response', async () => {
    const before = boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]);
    const after = boardOf([column('inspection', [job({ id: 'j1', stage: 'inspection' })])]);
    signedIn(before, {
      'PATCH /api/jobs/j1': () => {
        current = after;
        return { body: {} };
      },
    });
    const release = holdPatches();
    renderApp('/jobs');

    const leadRegion = await stageRegion('lead');
    const inspectionRegion = await stageRegion('inspection');
    const dataTransfer = { getData: () => 'j1', setData: () => {}, effectAllowed: 'none' };
    const link = within(leadRegion).getByRole('link', { name: /Pat Homeowner/ });

    fireEvent.dragStart(link, { dataTransfer });
    fireEvent.dragOver(inspectionRegion, { dataTransfer });
    fireEvent.drop(inspectionRegion, { dataTransfer });

    // The response is still held back, yet the card already sits in Inspection and the counts follow
    await waitFor(() => expect(within(inspectionRegion).getByRole('link', { name: /Pat Homeowner/ })).toBeInTheDocument());
    expect(within(leadRegion).queryByRole('link', { name: /Pat Homeowner/ })).not.toBeInTheDocument();
    expect(within(inspectionRegion).getByRole('heading', { name: jobs.columnHeader(jobs.stage.inspection, 1) })).toBeInTheDocument();
    expect(within(leadRegion).getByRole('heading', { name: jobs.columnHeader(jobs.stage.lead, 0) })).toBeInTheDocument();
    expect(patchBodies).toEqual([{ stage: 'inspection' }]);

    release();
    await waitFor(() => expect(api.count('PATCH /api/jobs/j1')).toBe(1));
    expect(api.sent('PATCH /api/jobs/j1')).toEqual([{ stage: 'inspection' }]);
  });

  it('a 400 rolls back and toasts', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]), {
      'PATCH /api/jobs/j1': () => ({ status: 400, body: { error: 'Mark the job Won first.' } }),
    });
    recordPatches();
    renderApp('/jobs');

    const leadRegion = await stageRegion('lead');
    const inspectionRegion = await stageRegion('inspection');
    const dataTransfer = { getData: () => 'j1', setData: () => {}, effectAllowed: 'none' };
    fireEvent.dragStart(within(leadRegion).getByRole('link', { name: /Pat Homeowner/ }), { dataTransfer });
    fireEvent.drop(inspectionRegion, { dataTransfer });

    expect(await screen.findByText('Mark the job Won first.')).toBeInTheDocument();
    expect(within(leadRegion).getByRole('link', { name: /Pat Homeowner/ })).toBeInTheDocument();
    expect(within(inspectionRegion).queryByRole('link', { name: /Pat Homeowner/ })).not.toBeInTheDocument();
    expect(within(leadRegion).getByRole('heading', { name: jobs.columnHeader(jobs.stage.lead, 1) })).toBeInTheDocument();
  });

  it('Move to Lost opens the sheet and sends stage lost with reason Price', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]), {
      'PATCH /api/jobs/j1': () => ({ body: {} }),
    });
    const { user } = renderApp('/jobs');

    await screen.findByRole('link', { name: /Pat Homeowner/ });
    await moveTo(user, 'Pat Homeowner', jobs.stage.lost);
    const sheet = await screen.findByRole('dialog', { name: jobs.sheetLost });
    await user.click(within(sheet).getByLabelText(jobs.lostReasonLabel, { selector: 'button' }));
    await user.click(await screen.findByRole('option', { name: 'Price' }));
    await user.click(within(sheet).getByRole('button', { name: jobs.confirm }));

    await waitFor(() => expect(api.sent('PATCH /api/jobs/j1')).toEqual([{ stage: 'lost', lostReason: 'Price' }]));
  });

  it('Won without a value asks for it', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead', valueCents: null })])]), {
      'PATCH /api/jobs/j1': () => ({ body: {} }),
    });
    const { user } = renderApp('/jobs');

    await screen.findByRole('link', { name: /Pat Homeowner/ });
    await moveTo(user, 'Pat Homeowner', jobs.stage.won);
    const sheet = await screen.findByRole('dialog', { name: jobs.sheetWon });
    await user.click(within(sheet).getByRole('button', { name: jobs.confirm }));

    expect(await within(sheet).findByText(jobs.needValue)).toBeInTheDocument();
    expect(api.count('PATCH /api/jobs/j1')).toBe(0);
  });

  it('Won takes a value with thousands commas', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead', valueCents: null })])]), {
      'PATCH /api/jobs/j1': () => ({ body: {} }),
    });
    const { user } = renderApp('/jobs');

    await screen.findByRole('link', { name: /Pat Homeowner/ });
    await moveTo(user, 'Pat Homeowner', jobs.stage.won);
    const sheet = await screen.findByRole('dialog', { name: jobs.sheetWon });
    await user.type(within(sheet).getByLabelText(jobs.valueLabel), '12,500');
    await user.click(within(sheet).getByRole('button', { name: jobs.confirm }));

    await waitFor(() => expect(api.sent('PATCH /api/jobs/j1')).toEqual([{ stage: 'won', valueCents: 1250000 }]));
  });

  it('Won refuses a value with letters in it', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead', valueCents: null })])]), {
      'PATCH /api/jobs/j1': () => ({ body: {} }),
    });
    const { user } = renderApp('/jobs');

    await screen.findByRole('link', { name: /Pat Homeowner/ });
    await moveTo(user, 'Pat Homeowner', jobs.stage.won);
    const sheet = await screen.findByRole('dialog', { name: jobs.sheetWon });
    await user.type(within(sheet).getByLabelText(jobs.valueLabel), '12abc');
    await user.click(within(sheet).getByRole('button', { name: jobs.confirm }));

    expect(await within(sheet).findByText(jobs.needValue)).toBeInTheDocument();
    expect(api.count('PATCH /api/jobs/j1')).toBe(0);
  });

  it('Won refuses commas that are not thousands groups', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead', valueCents: null })])]), {
      'PATCH /api/jobs/j1': () => ({ body: {} }),
    });
    const { user } = renderApp('/jobs');

    await screen.findByRole('link', { name: /Pat Homeowner/ });
    await moveTo(user, 'Pat Homeowner', jobs.stage.won);
    const sheet = await screen.findByRole('dialog', { name: jobs.sheetWon });
    await user.type(within(sheet).getByLabelText(jobs.valueLabel), '1,2,3');
    await user.click(within(sheet).getByRole('button', { name: jobs.confirm }));

    expect(await within(sheet).findByText(jobs.needValue)).toBeInTheDocument();
    expect(api.count('PATCH /api/jobs/j1')).toBe(0);
  });

  it('Installed is not offered unless the job is Won', async () => {
    signedIn(
      boardOf([
        column('lead', [job({ id: 'j1', stage: 'lead', customerName: 'Lead Customer' })]),
        column('won', [job({ id: 'j2', stage: 'won', customerName: 'Won Customer', valueCents: 500000 })], 500000),
      ]),
    );
    const { user } = renderApp('/jobs');

    await screen.findByRole('link', { name: /Won Customer/ });
    const leadList = await openMove(user, 'Lead Customer');
    expect(within(leadList).queryByRole('option', { name: jobs.stage.installed })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    const wonList = await openMove(user, 'Won Customer');
    expect(within(wonList).getByRole('option', { name: jobs.stage.installed })).toBeInTheDocument();
  });

  it('a move through the menu says so with Undo, and Undo moves it back without another toast', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]), {
      'PATCH /api/jobs/j1': () => ({ body: {} }),
    });
    const { user } = renderApp('/jobs');

    await screen.findByRole('link', { name: /Pat Homeowner/ });
    await moveTo(user, 'Pat Homeowner', jobs.stage.inspection);
    await waitFor(() => expect(api.sent('PATCH /api/jobs/j1')).toEqual([{ stage: 'inspection' }]));

    const status = screen.getByRole('status');
    expect(await within(status).findByText(jobs.movedTo('Pat Homeowner', jobs.stage.inspection))).toBeInTheDocument();
    await user.click(within(status).getByRole('button', { name: jobs.undo }));
    await waitFor(() => expect(api.sent('PATCH /api/jobs/j1')).toEqual([{ stage: 'inspection' }, { stage: 'lead' }]));
    await waitFor(() => expect(status).toBeEmptyDOMElement());
  });

  it('a drag says so with Undo too', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]), {
      'PATCH /api/jobs/j1': () => ({ body: {} }),
    });
    renderApp('/jobs');

    const leadRegion = await stageRegion('lead');
    const inspectionRegion = await stageRegion('inspection');
    const dataTransfer = { getData: () => 'j1', setData: () => {}, effectAllowed: 'none' };
    fireEvent.dragStart(within(leadRegion).getByRole('link', { name: /Pat Homeowner/ }), { dataTransfer });
    fireEvent.drop(inspectionRegion, { dataTransfer });

    const status = screen.getByRole('status');
    expect(await within(status).findByText(jobs.movedTo('Pat Homeowner', jobs.stage.inspection))).toBeInTheDocument();
    expect(within(status).getByRole('button', { name: jobs.undo })).toBeInTheDocument();
  });

  it('a refused move shows no Undo', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]), {
      'PATCH /api/jobs/j1': () => ({ status: 400, body: { error: 'Mark the job Won first.' } }),
    });
    const { user } = renderApp('/jobs');

    await screen.findByRole('link', { name: /Pat Homeowner/ });
    await moveTo(user, 'Pat Homeowner', jobs.stage.proposal);
    expect(await screen.findByText('Mark the job Won first.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: jobs.undo })).not.toBeInTheDocument();
  });

  it('the menu moves on a number key, opens the sheet on L, and picking the current stage does nothing', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]), {
      'PATCH /api/jobs/j1': () => ({ body: {} }),
    });
    const { user } = renderApp('/jobs');

    await screen.findByRole('link', { name: /Pat Homeowner/ });
    await openMove(user, 'Pat Homeowner');
    await user.keyboard('1');
    expect(api.count('PATCH /api/jobs/j1')).toBe(0);

    await openMove(user, 'Pat Homeowner');
    await user.keyboard('l');
    expect(await screen.findByRole('dialog', { name: jobs.sheetLost })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: jobs.cancel }));

    await openMove(user, 'Pat Homeowner');
    await user.keyboard('3');
    await waitFor(() => expect(api.sent('PATCH /api/jobs/j1')).toEqual([{ stage: 'proposal' }]));
  });

  it('the stages are numbered, the current one is checked, and Lost and Archive follow', async () => {
    signedIn(boardOf([column('inspection', [job({ id: 'j1', stage: 'inspection' })])]));
    const { user } = renderApp('/jobs');

    await screen.findByRole('link', { name: /Pat Homeowner/ });
    const list = await openMove(user, 'Pat Homeowner');
    const options = within(list).getAllByRole('option');
    expect(options.map((option) => option.textContent?.replace(/\d$|[LE]$/, ''))).toEqual([
      jobs.stage.lead,
      jobs.stage.inspection,
      jobs.stage.proposal,
      jobs.stage.won,
      jobs.stage.lost,
      jobs.archiveOption,
    ]);
    expect(options.filter((option) => option.getAttribute('aria-selected') === 'true').map((option) => option.textContent)).toEqual([
      expect.stringContaining(jobs.stage.inspection),
    ]);
  });

  it('Archive posts to the archive route and says so with Undo, which restores', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]), {
      'POST /api/jobs/j1/archive': () => ({ body: {} }),
      'POST /api/jobs/j1/unarchive': () => ({ body: {} }),
    });
    const { user } = renderApp('/jobs');

    await screen.findByRole('link', { name: /Pat Homeowner/ });
    await moveTo(user, 'Pat Homeowner', jobs.archiveOption);
    await waitFor(() => expect(api.count('POST /api/jobs/j1/archive')).toBe(1));

    const status = screen.getByRole('status');
    expect(await within(status).findByText(jobs.archivedJob('Pat Homeowner'))).toBeInTheDocument();
    await user.click(within(status).getByRole('button', { name: jobs.undo }));
    await waitFor(() => expect(api.count('POST /api/jobs/j1/unarchive')).toBe(1));
  });

  it('a rep is not offered Archive on a job that is not theirs', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead', assigned: { userId: 'someone-else', name: 'Casey' } })])]), {
      'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'rep' } }),
    });
    const { user } = renderApp('/jobs');

    await screen.findByRole('link', { name: /Pat Homeowner/ });
    const list = await openMove(user, 'Pat Homeowner');
    expect(within(list).queryByRole('option', { name: jobs.archiveOption })).not.toBeInTheDocument();
    expect(within(list).getByRole('option', { name: jobs.stage.lost })).toBeInTheDocument();
  });

  it('filters update the URL and the request', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]));
    api.routes['GET /api/jobs/board?q=roof'] = () => ({ body: current });
    api.routes['GET /api/jobs/board?assigned=me&q=roof'] = () => ({ body: current });
    const { router, user } = renderApp('/jobs');

    await board();
    await user.type(screen.getByLabelText(jobs.filterSearch), 'roof');
    await waitFor(() => expect(api.count('GET /api/jobs/board?q=roof')).toBe(1), { timeout: 2000 });
    expect(where(router)).toContain('q=roof');

    // The Assigned filter is a chip: it opens a list of choices and writes the one picked to the URL
    await user.click(screen.getByRole('button', { name: `${jobs.filterAssignee}: ${jobs.filterAll}` }));
    await user.click(await screen.findByRole('option', { name: jobs.filterMine }));
    await waitFor(() => expect(api.count('GET /api/jobs/board?assigned=me&q=roof')).toBe(1));
    expect(where(router)).toContain('assigned=me');
    expect(where(router)).toContain('q=roof');
    expect(screen.getByRole('button', { name: `${jobs.filterAssignee}: ${jobs.filterMine}` })).toBeInTheDocument();
  });

  it('a card from Show N more can be dragged to another stage', async () => {
    signedIn(boardOf([{ ...column('lead', [job({ id: 'j1', stage: 'lead' })]), count: 3 }]), {
      'GET /api/jobs/board?stage=lead&offset=1': () => ({
        body: { ...column('lead', [job({ id: 'j2', stage: 'lead', customerName: 'Lee Extra' })]), count: 3 },
      }),
      'PATCH /api/jobs/j2': () => {
        current = boardOf([
          { ...column('lead', [job({ id: 'j1', stage: 'lead' })]), count: 2 },
          column('inspection', [job({ id: 'j2', stage: 'inspection', customerName: 'Lee Extra' })]),
        ]);
        return { body: {} };
      },
    });
    const { user } = renderApp('/jobs');

    const leadRegion = await stageRegion('lead');
    await user.click(within(leadRegion).getByRole('button', { name: jobs.showMore(2) }));
    await waitFor(() => expect(within(leadRegion).getByRole('link', { name: /Lee Extra/ })).toBeInTheDocument());

    const inspectionRegion = await stageRegion('inspection');
    const dataTransfer = { getData: () => 'j2', setData: () => {}, effectAllowed: 'none' };
    fireEvent.dragStart(within(leadRegion).getByRole('link', { name: /Lee Extra/ }), { dataTransfer });
    fireEvent.dragOver(inspectionRegion, { dataTransfer });
    fireEvent.drop(inspectionRegion, { dataTransfer });

    await waitFor(() => {
      expect(within(leadRegion).queryByRole('link', { name: /Lee Extra/ })).not.toBeInTheDocument();
      expect(within(inspectionRegion).getAllByRole('link', { name: /Lee Extra/ })).toHaveLength(1);
    });
    expect(api.sent('PATCH /api/jobs/j2')).toEqual([{ stage: 'inspection' }]);
  });

  it('list Show N more adds the next page of a stage to the table', async () => {
    signedIn(boardOf([{ ...column('lead', [job({ id: 'j1', stage: 'lead' })]), count: 3 }]), {
      'GET /api/jobs/board?stage=lead&offset=1': () => ({
        body: {
          ...column('lead', [
            job({ id: 'j2', stage: 'lead', customerName: 'Lee Extra' }),
            job({ id: 'j3', stage: 'lead', customerName: 'Kim Extra' }),
          ]),
          count: 3,
        },
      }),
    });
    const { user } = renderApp('/jobs?view=list');

    const table = await screen.findByRole('table', { name: jobs.listLabel });
    expect(within(table).getAllByRole('link')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: jobs.showMore(2) }));

    await waitFor(() => expect(within(table).getByRole('link', { name: /Lee Extra/ })).toBeInTheDocument());
    expect(within(table).getByRole('link', { name: /Kim Extra/ })).toBeInTheDocument();
    expect(within(table).getAllByRole('link')).toHaveLength(3);
    expect(api.count('GET /api/jobs/board?stage=lead&offset=1')).toBe(1);
  });

  it('phone shows the list', async () => {
    phoneMode.phone = true;
    signedIn(
      boardOf([
        column('lead', [job({ id: 'j1', stage: 'lead', customerName: 'Lead Customer' })]),
        column('inspection', [job({ id: 'j2', stage: 'inspection', customerName: 'Inspect Customer' })]),
      ]),
    );
    renderApp('/jobs');

    const list = await screen.findByRole('list', { name: jobs.listLabel });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('region', { name: jobs.boardLabel })).not.toBeInTheDocument();
  });
});

describe('jobs page head', () => {
  it('counts only what is real: open jobs, the money in play and the proposals waiting', async () => {
    waiting = { sent: 2, viewed: 1 };
    signedIn(
      boardOf([
        column('lead', [job({ id: 'j1', stage: 'lead' }), job({ id: 'j2', stage: 'lead', customerName: 'Sam Two' })], 0),
        column('proposal', [job({ id: 'j3', stage: 'proposal', customerName: 'Lee Three', valueCents: 1250000 })], 1250000),
      ]),
    );
    renderApp('/jobs');

    const main = await screen.findByRole('main', { name: 'Jobs' });
    expect(
      await within(main).findByText(
        [jobs.subtitle.open(3), jobs.subtitle.inPlay('$12,500'), jobs.subtitle.waiting(3)].join(jobs.subtitle.join),
      ),
    ).toBeInTheDocument();
  });

  it('leaves out the money when the server sends none, and the proposals when there are none', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })], null)]));
    renderApp('/jobs');

    const main = await screen.findByRole('main', { name: 'Jobs' });
    expect(await within(main).findByText(jobs.subtitle.open(1))).toBeInTheDocument();
  });

  it('does not count proposals for a filtered board: they are not the board\'s', async () => {
    waiting = { sent: 4, viewed: 0 };
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]));
    api.routes['GET /api/jobs/board?assigned=me'] = () => ({ body: current });
    renderApp('/jobs?assigned=me');

    const main = await screen.findByRole('main', { name: 'Jobs' });
    expect(await within(main).findByText(jobs.subtitle.open(1))).toBeInTheDocument();
    expect(api.count('GET /api/proposals?status=sent')).toBe(0);
  });

  it('the archived view shows only the archived jobs and says how many there are', async () => {
    // The server's archived=true is the open jobs and the archived ones together; the archived ones are what the open board lacks
    const stillOpen = job({ id: 'j2', stage: 'lead', customerName: 'Olive Open' });
    signedIn(boardOf([column('lead', [stillOpen])]));
    api.routes['GET /api/jobs/board?archived=true'] = () => ({
      body: boardOf([column('lead', [job({ id: 'j1', stage: 'lead', customerName: 'Arthur Archived' }), stillOpen])]),
    });
    renderApp('/jobs?archived=true');

    const main = await screen.findByRole('main', { name: 'Jobs' });
    expect(await within(main).findByText(jobs.subtitle.archived(1))).toBeInTheDocument();
    expect(await within(main).findByText('Arthur Archived')).toBeInTheDocument();
    expect(within(main).queryByText('Olive Open')).not.toBeInTheDocument();
  });

  it('the archived view counts a stage by its archived jobs and adds up their value', async () => {
    const open = job({ id: 'j2', stage: 'proposal', valueCents: 700_000 });
    signedIn(boardOf([column('proposal', [open], 700_000)]));
    api.routes['GET /api/jobs/board?archived=true'] = () => ({
      body: boardOf([column('proposal', [job({ id: 'j1', stage: 'proposal', customerName: 'Arthur Archived', valueCents: 1_250_000 }), open], 1_950_000)]),
    });
    renderApp('/jobs?archived=true');

    const lane = await screen.findByRole('region', { name: jobs.stage.proposal });
    expect(within(lane).getByText('Arthur Archived')).toBeInTheDocument();
    expect(lane.querySelector('[data-part="lane-total"]')).toHaveTextContent(jobs.total('$12,500'));
  });

  it('the archived view finds archived jobs past the first page of a long stage', async () => {
    // Three leads in all, one of them archived and on the second page; the open board has the other two
    const first = job({ id: 'j1', stage: 'lead', customerName: 'Olive Open' });
    const second = job({ id: 'j2', stage: 'lead', customerName: 'Owen Open' });
    const archived = job({ id: 'j3', stage: 'lead', customerName: 'Arthur Archived' });
    signedIn(boardOf([column('lead', [first, second])]));
    api.routes['GET /api/jobs/board?archived=true'] = () => ({
      body: boardOf([{ stage: 'lead', count: 3, totalCents: null, jobs: [first, second] }]),
    });
    api.routes['GET /api/jobs/board?archived=true&stage=lead&offset=2'] = () => ({
      body: { stage: 'lead', count: 3, totalCents: null, jobs: [archived] },
    });
    renderApp('/jobs?archived=true');

    const main = await screen.findByRole('main', { name: 'Jobs' });
    expect(await within(main).findByText('Arthur Archived')).toBeInTheDocument();
    expect(within(main).queryByText('Olive Open')).not.toBeInTheDocument();
    expect(within(main).getByText(jobs.subtitle.archived(1))).toBeInTheDocument();
  });

  it('the archived view with nothing archived says so', async () => {
    const lead = job({ id: 'j1', stage: 'lead' });
    signedIn(boardOf([column('lead', [lead])]));
    api.routes['GET /api/jobs/board?archived=true'] = () => ({ body: boardOf([column('lead', [lead])]) });
    renderApp('/jobs?archived=true');

    const main = await screen.findByRole('main', { name: 'Jobs' });
    expect(await within(main).findByText(jobs.emptyArchived)).toBeInTheDocument();
    expect(within(main).queryByText('Pat Homeowner')).not.toBeInTheDocument();
  });

  it('the archived view has no "add a job" button on its lanes', async () => {
    const stillOpen = job({ id: 'j2', stage: 'lead', customerName: 'Olive Open' });
    signedIn(boardOf([column('lead', [stillOpen])]));
    api.routes['GET /api/jobs/board?archived=true'] = () => ({
      body: boardOf([column('lead', [job({ id: 'j1', stage: 'lead', customerName: 'Arthur Archived' }), stillOpen])]),
    });
    renderApp('/jobs?archived=true');

    await screen.findByText('Arthur Archived');
    expect(screen.queryByRole('link', { name: jobs.addToStage(jobs.stage.lead) })).not.toBeInTheDocument();
  });

  it('the archived list shows only the archived jobs too', async () => {
    const stillOpen = job({ id: 'j2', stage: 'lead', customerName: 'Olive Open' });
    signedIn(boardOf([column('lead', [stillOpen])]));
    api.routes['GET /api/jobs/board?archived=true'] = () => ({
      body: boardOf([column('lead', [job({ id: 'j1', stage: 'lead', customerName: 'Arthur Archived' }), stillOpen])]),
    });
    renderApp('/jobs?archived=true&view=list');

    const table = await screen.findByRole('table', { name: jobs.listLabel });
    expect(within(table).getByText('Arthur Archived')).toBeInTheDocument();
    expect(within(table).queryByText('Olive Open')).not.toBeInTheDocument();
  });

  it('offers Export to the owner and New job to everyone', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]));
    renderApp('/jobs');

    const main = await screen.findByRole('main', { name: 'Jobs' });
    expect(within(main).getByRole('link', { name: jobs.export })).toHaveAttribute('href', '/api/export/jobs.csv');
    expect(within(main).getByRole('link', { name: jobs.newJob })).toHaveAttribute('href', '/jobs/new');
  });

  it('shows a rep no Export', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]), {
      'GET /api/auth/me': () => ({ body: { ...ACCOUNT, role: 'rep' } }),
    });
    renderApp('/jobs');

    const main = await screen.findByRole('main', { name: 'Jobs' });
    await within(main).findByRole('link', { name: jobs.newJob });
    expect(within(main).queryByRole('link', { name: jobs.export })).not.toBeInTheDocument();
  });

  it('has the Pipeline, Customers and Archived tabs, with the current one marked', async () => {
    signedIn(boardOf());
    renderApp('/jobs');

    const tabs = await screen.findByRole('navigation', { name: jobs.tabsLabel });
    expect(within(tabs).getByRole('link', { name: jobs.tabs.pipeline })).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).getByRole('link', { name: jobs.tabs.customers })).toHaveAttribute('href', '/customers');
    expect(within(tabs).getByRole('link', { name: jobs.tabs.archived })).toHaveAttribute('href', '/jobs?archived=true');
    expect(within(tabs).getByRole('link', { name: jobs.tabs.archived })).not.toHaveAttribute('aria-current');
  });

  it('marks Archived as the current tab on the archived view', async () => {
    signedIn(boardOf());
    api.routes['GET /api/jobs/board?archived=true'] = () => ({ body: boardOf() });
    renderApp('/jobs?archived=true');

    const tabs = await screen.findByRole('navigation', { name: jobs.tabsLabel });
    expect(within(tabs).getByRole('link', { name: jobs.tabs.archived })).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).getByRole('link', { name: jobs.tabs.pipeline })).not.toHaveAttribute('aria-current');
  });

  it('switches between Board and List and keeps the choice in the URL', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]));
    const { router, user } = renderApp('/jobs');

    await board();
    const views = screen.getByRole('radiogroup', { name: jobs.viewLabel });
    expect(within(views).getByRole('radio', { name: jobs.views.board })).toBeChecked();

    await user.click(within(views).getByRole('radio', { name: jobs.views.list }));
    expect(await screen.findByRole('table', { name: jobs.listLabel })).toBeInTheDocument();
    expect(where(router)).toContain('view=list');
    expect(screen.queryByRole('region', { name: jobs.boardLabel })).not.toBeInTheDocument();

    await user.click(within(screen.getByRole('radiogroup', { name: jobs.viewLabel })).getByRole('radio', { name: jobs.views.board }));
    await board();
    expect(where(router)).not.toContain('view=');
  });

  it('has no view switch on a phone: the list is the view, and the filters are one row of chips', async () => {
    phoneMode.phone = true;
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]));
    renderApp('/jobs');

    await screen.findByRole('list', { name: jobs.listLabel });
    expect(screen.queryByRole('radiogroup', { name: jobs.viewLabel })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `${jobs.filterAssignee}: ${jobs.filterAll}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `${jobs.filterSource}: ${jobs.filterSourceAll}` })).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('the slash key jumps to the search, but is just a character once you are typing', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]));
    const { user } = renderApp('/jobs');

    await board();
    const search = screen.getByLabelText(jobs.filterSearch);
    expect(search).not.toHaveFocus();
    await user.keyboard('/');
    expect(search).toHaveFocus();
    expect(search).toHaveValue('');

    await user.keyboard('a/b');
    expect(search).toHaveValue('a/b');
    await user.keyboard('{Escape}');
    expect(search).not.toHaveFocus();
  });

  it('does not take the slash key while a dialog is open', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]));
    const { user } = renderApp('/jobs');

    await screen.findByRole('link', { name: /Pat Homeowner/ });
    await moveTo(user, 'Pat Homeowner', jobs.stage.lost);
    await screen.findByRole('dialog', { name: jobs.sheetLost });
    await user.keyboard('/');
    expect(screen.getByLabelText(jobs.filterSearch)).not.toHaveFocus();
  });
});

describe('board cards and lanes', () => {
  const today = localDate(new Date(), 'America/Chicago');

  it('a card shows the name, the address, the next step, the value, the rep and the days', async () => {
    signedIn(
      boardOf([
        column(
          'proposal',
          [
            job({
              id: 'j1',
              stage: 'proposal',
              customerName: 'Ashley Thomas',
              addressLine: '193 Ames Ave',
              valueCents: 1100000,
              assigned: { userId: 'u2', name: 'Casey Moreno' },
              daysInStage: 4,
              nextStep: 'Call about financing',
              nextStepOn: today,
            }),
          ],
          1100000,
        ),
      ]),
    );
    renderApp('/jobs');

    const link = await screen.findByRole('link', { name: /Ashley Thomas/ });
    expect(link).toHaveTextContent('193 Ames Ave');
    // Due today: the Today tag says it and the line does not say it a second time
    expect(link).toHaveTextContent('Call about financing');
    expect(link).not.toHaveTextContent('Call about financing ·');
    expect(link).toHaveTextContent('$11,000');
    expect(link).toHaveTextContent('Casey Moreno');
    // The aging reads in words for a screen reader and as "4d" on the card
    expect(link).toHaveTextContent(jobs.daysInStage(4));
    expect(link).toHaveTextContent(jobs.daysShort(4));
    // Due today earns the card its one tag
    expect(within(link).getByText(jobs.tagToday)).toBeInTheDocument();
  });

  it('a card with no data to show carries no tag, no next step and no value', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead', valueCents: null, nextStep: null, nextStepOn: null })])]));
    renderApp('/jobs');

    const link = await screen.findByRole('link', { name: /Pat Homeowner/ });
    expect(within(link).queryByText(jobs.tagToday)).not.toBeInTheDocument();
    expect(within(link).queryByText(jobs.tagOverdue)).not.toBeInTheDocument();
    expect(link).not.toHaveTextContent('$');
    expect(link).toHaveTextContent(jobs.unassigned);
  });

  it('a next step on another day keeps its date, and the last word, the dot and the date cannot be pulled apart', async () => {
    signedIn(
      boardOf([
        column('won', [job({ id: 'j1', stage: 'won', nextStep: 'Confirm the install day', nextStepOn: '2099-10-17' })]),
      ]),
    );
    renderApp('/jobs');

    const link = await screen.findByRole('link', { name: /Pat Homeowner/ });
    expect(link).toHaveTextContent('Confirm the install day · Oct 17');
    // No tag: nothing is due today and nothing is late
    expect(within(link).queryByText(jobs.tagToday)).not.toBeInTheDocument();
    // The break may fall before "day" and nowhere after it: the spaces around the dot and inside the date do not break
    expect(link.textContent).toContain('Confirm the install day\u00a0·\u00a0Oct\u00a017');
  });

  it('a lane fades at its bottom edge only while there is more to scroll to', async () => {
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(600);
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
    try {
      signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]));
      renderApp('/jobs');

      const lane = (await screen.findByRole('region', { name: jobs.stage.lead })).querySelector('[data-more]');
      expect(lane).toHaveAttribute('data-more', 'true');
      // Scrolled to the end, the fade goes
      scrollHeight.mockReturnValue(200);
      fireEvent.scroll(lane as HTMLElement);
      await waitFor(() => expect(lane).not.toHaveAttribute('data-more'));
    } finally {
      scrollHeight.mockRestore();
      clientHeight.mockRestore();
    }
  });

  it('a next step that is past due is tagged Overdue, and a stuck job says so', async () => {
    signedIn(
      boardOf([
        column('lead', [job({ id: 'j1', stage: 'lead', nextStep: 'Call back', nextStepOn: '2020-01-02', stuck: true, daysInStage: 9 })]),
      ]),
    );
    renderApp('/jobs');

    const link = await screen.findByRole('link', { name: /Pat Homeowner/ });
    expect(within(link).getByText(jobs.tagOverdue)).toBeInTheDocument();
    expect(link).toHaveTextContent(jobs.stuck(9));
    expect(cardFor('Pat Homeowner')).toHaveAttribute('data-stuck', 'true');
  });

  it('the split button moves the job to the next stage in one click', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]), {
      'PATCH /api/jobs/j1': () => ({ body: {} }),
    });
    const { user } = renderApp('/jobs');

    await screen.findByRole('link', { name: /Pat Homeowner/ });
    await user.click(within(cardFor('Pat Homeowner')).getByRole('button', { name: jobs.moveToStage(jobs.stage.inspection) }));
    await waitFor(() => expect(api.sent('PATCH /api/jobs/j1')).toEqual([{ stage: 'inspection' }]));
    expect(await within(screen.getByRole('status')).findByText(jobs.movedTo('Pat Homeowner', jobs.stage.inspection))).toBeInTheDocument();
  });

  it('the split button into Won still asks for a value when the job has none', async () => {
    signedIn(boardOf([column('proposal', [job({ id: 'j1', stage: 'proposal', valueCents: null })])]));
    const { user } = renderApp('/jobs');

    await screen.findByRole('link', { name: /Pat Homeowner/ });
    await user.click(within(cardFor('Pat Homeowner')).getByRole('button', { name: jobs.moveToStage(jobs.stage.won) }));
    expect(await screen.findByRole('dialog', { name: jobs.sheetWon })).toBeInTheDocument();
    expect(api.count('PATCH /api/jobs/j1')).toBe(0);
  });

  it('an Installed card has only the menu: nothing follows Installed', async () => {
    signedIn(boardOf([column('installed', [job({ id: 'j1', stage: 'installed' })])]));
    renderApp('/jobs');

    await screen.findByRole('link', { name: /Pat Homeowner/ });
    const card = cardFor('Pat Homeowner');
    expect(within(card).getByRole('button', { name: jobs.moveTo })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /^Move to [A-Z]/ })).not.toBeInTheDocument();
  });

  it('a lane\'s plus adds a job in that stage, for the stages a job can start in', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]));
    renderApp('/jobs');

    const lead = await stageRegion('lead');
    expect(within(lead).getByRole('link', { name: jobs.addToStage(jobs.stage.lead) })).toHaveAttribute('href', '/jobs/new?stage=lead');
    const proposal = await stageRegion('proposal');
    expect(within(proposal).getByRole('link', { name: jobs.addToStage(jobs.stage.proposal) })).toHaveAttribute('href', '/jobs/new?stage=proposal');
    // Won needs a value and Installed only follows Won: no plus there
    expect(within(await stageRegion('won')).queryByRole('link', { name: /^Add a job/ })).not.toBeInTheDocument();
    expect(within(await stageRegion('installed')).queryByRole('link', { name: /^Add a job/ })).not.toBeInTheDocument();
  });

  it('every lane carries its share of the money in play', async () => {
    signedIn(
      boardOf([
        column('proposal', [job({ id: 'j1', stage: 'proposal', valueCents: 3000000 })], 3000000),
        column('won', [job({ id: 'j2', stage: 'won', customerName: 'Won Customer', valueCents: 1000000 })], 1000000),
      ]),
    );
    renderApp('/jobs');

    const proposal = await stageRegion('proposal');
    const fill = proposal.querySelector<HTMLElement>('[class*="meterFill"]');
    expect(fill).toHaveStyle({ width: '75%' });
    expect((await stageRegion('won')).querySelector<HTMLElement>('[class*="meterFill"]')).toHaveStyle({ width: '25%' });
  });

  it('Lost is a tab with its count that opens a drawer, and a card dropped on it asks why', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])], 3));
    const { user } = renderApp('/jobs');

    const tab = await screen.findByRole('button', { name: jobs.lostDrawer(3) });
    expect(tab).toHaveAttribute('aria-expanded', 'false');
    await user.click(tab);
    expect(tab).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(jobs.lostDropHint)).toBeInTheDocument();
    await user.click(tab);
    expect(tab).toHaveAttribute('aria-expanded', 'false');

    // Collapsed or open, the lane takes a dropped card
    const dataTransfer = { getData: () => 'j1', setData: () => {}, effectAllowed: 'none' };
    fireEvent.dragStart(screen.getByRole('link', { name: /Pat Homeowner/ }), { dataTransfer });
    fireEvent.dragOver(tab.parentElement as HTMLElement, { dataTransfer });
    fireEvent.drop(tab.parentElement as HTMLElement, { dataTransfer });
    expect(await screen.findByRole('dialog', { name: jobs.sheetLost })).toBeInTheDocument();
  });

  it('an empty pipeline shows what the board is for and a New job button, never a bare sentence', async () => {
    signedIn(boardOf());
    renderApp('/jobs');

    expect(await screen.findByText(jobs.emptyBoard)).toBeInTheDocument();
    const pipeline = await board();
    expect(within(pipeline).getByText(jobs.emptyBoardBody)).toBeInTheDocument();
    expect(within(pipeline).getByRole('link', { name: jobs.newJob })).toHaveAttribute('href', '/jobs/new');
  });

  it('a search that finds nothing says so and offers to clear the filters', async () => {
    signedIn(boardOf());
    api.routes['GET /api/jobs/board?q=zzz'] = () => ({ body: current });
    const { router, user } = renderApp('/jobs?q=zzz');

    expect(await screen.findByText(jobs.emptyFiltered)).toBeInTheDocument();
    const pipeline = await board();
    await user.click(within(pipeline).getByRole('button', { name: jobs.clearFilters }));
    await waitFor(() => expect(where(router)).not.toContain('q='));
  });

  it('a failed load shows the error in place with Try again', async () => {
    signedIn(boardOf(), { 'GET /api/jobs/board': () => ({ status: 500, body: { error: 'down' } }) });
    const { user } = renderApp('/jobs');

    // The toast region is a live region too; the error is the alert that holds the sentence
    const alert = (await screen.findByText(jobs.loadFailed)).closest<HTMLElement>('[role="alert"]')!;
    expect(within(alert).getByText(jobs.errorTag)).toBeInTheDocument();
    current = boardOf([column('lead', [job({ id: 'j1', stage: 'lead' })])]);
    api.routes['GET /api/jobs/board'] = () => ({ body: current });
    await user.click(within(alert).getByRole('button', { name: jobs.retry }));
    expect(await screen.findByRole('link', { name: /Pat Homeowner/ })).toBeInTheDocument();
  });
});

describe('jobs list', () => {
  it('has mono heads, the stage as a tag, the value, the rep, the age and a Move to menu on every row', async () => {
    signedIn(
      boardOf([
        column('proposal', [
          job({ id: 'j1', stage: 'proposal', customerName: 'Ashley Thomas', valueCents: 1100000, assigned: { userId: 'u2', name: 'Casey Moreno' }, daysInStage: 4 }),
        ]),
      ]),
    );
    renderApp('/jobs?view=list');

    const table = await screen.findByRole('table', { name: jobs.listLabel });
    for (const heading of [jobs.listColumns.job, jobs.listColumns.stage, jobs.listColumns.value, jobs.listColumns.rep, jobs.listColumns.age, jobs.listColumns.updated]) {
      expect(within(table).getByRole('columnheader', { name: heading })).toBeInTheDocument();
    }
    const row = within(table).getByRole('row', { name: /Ashley Thomas/ });
    expect(within(row).getByText(jobs.stage.proposal)).toBeInTheDocument();
    expect(within(row).getByText('$11,000')).toBeInTheDocument();
    expect(within(row).getByText('Casey Moreno')).toBeInTheDocument();
    expect(within(row).getByText(jobs.daysShort(4))).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: jobs.moveTo })).toBeInTheDocument();
  });

  it('a job with no value yet has a quiet dash in the Value column and says so in words', async () => {
    signedIn(boardOf([column('lead', [job({ id: 'j1', stage: 'lead', customerName: 'Pat Homeowner', valueCents: null })])]));
    renderApp('/jobs?view=list');

    const table = await screen.findByRole('table', { name: jobs.listLabel });
    const row = within(table).getByRole('row', { name: /Pat Homeowner/ });
    const dash = within(row).getByText(jobs.noValueDash);
    expect(dash).toHaveAttribute('aria-hidden', 'true');
    expect(within(row).getByText(jobs.noValueYet)).toHaveClass('visually-hidden');
  });

  it('an empty list says what is missing and offers a New job button', async () => {
    signedIn(boardOf());
    renderApp('/jobs?view=list');

    expect(await screen.findByText(jobs.emptyBoard)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: jobs.newJob }).length).toBeGreaterThan(0);
  });

  it('a phone card has the name and stage, the address, and the value, rep and age, with the stage menu', async () => {
    phoneMode.phone = true;
    signedIn(
      boardOf([
        column('inspection', [
          job({ id: 'j1', stage: 'inspection', customerName: 'Nancy White', addressLine: '7555 Elm St', valueCents: 1450000, assigned: { userId: 'u2', name: 'Casey Moreno' } }),
        ]),
      ]),
    );
    renderApp('/jobs');

    const list = await screen.findByRole('list', { name: jobs.listLabel });
    const card = within(list).getByRole('listitem');
    expect(card).toHaveTextContent('Nancy White');
    expect(card).toHaveTextContent(jobs.stage.inspection);
    expect(card).toHaveTextContent('7555 Elm St');
    expect(card).toHaveTextContent('$14,500');
    expect(within(card).getByRole('button', { name: jobs.moveTo })).toBeInTheDocument();
  });
});

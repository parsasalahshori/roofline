import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOARD_STAGES, type BoardColumn, type BoardStage, type BoardView, type JobCard, type JobStage } from '@roofline/shared';
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
/** While set, every PATCH waits for it before it reaches the stub. */
let heldPatch: Promise<void> | null = null;
/** The bodies of every PATCH, recorded the moment it is sent (held or not). */
let patchBodies: unknown[] = [];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  heldPatch = null;
  patchBodies = [];
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
    expect(within(lead).getByText(jobs.total('$12,500'))).toBeInTheDocument();
    const inspection = await stageRegion('inspection');
    expect(within(inspection).queryByText(/total/)).not.toBeInTheDocument();
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
    await user.selectOptions(within(sheet).getByLabelText(jobs.lostReasonLabel), 'Price');
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

    await user.selectOptions(screen.getByLabelText(jobs.filterAssignee), 'me');
    await waitFor(() => expect(api.count('GET /api/jobs/board?assigned=me&q=roof')).toBe(1));
    expect(where(router)).toContain('assigned=me');
    expect(where(router)).toContain('q=roof');
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

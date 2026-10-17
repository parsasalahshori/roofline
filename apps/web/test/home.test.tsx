import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepView } from '../src/api/types.ts';
import { createAppRouter } from '../src/app/router.tsx';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { approvals } from '../src/copy/approvals.ts';
import { home } from '../src/copy/home.ts';
import { ACCOUNT, makeTask, SHELL_ROUTES, stubApi } from './helpers.tsx';

// The real map loads maplibre-gl, which these tests never need
vi.mock('../src/shell/map/MapView.tsx', async () => {
  const { createElement } = await import('react');
  return { MapView: () => createElement('div', { 'data-map-mock': true }) };
});

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

const DANA = { ...ACCOUNT, user: { ...ACCOUNT.user, name: 'Dana Ruiz' } };
const COMPANY_BODY = { id: 'c1', name: 'Summit Roofing', slug: 'summit-roofing', status: 'active', timezone: 'America/Chicago' };

/** Friday, October 16 2026, noon in Chicago */
const NOW = new Date('2026-10-16T17:00:00.000Z');

const STORM = {
  id: 's1',
  placeName: 'West Omaha, NE',
  day: '2026-10-13',
  maxIn: 1.5,
  status: 'final',
  customersHit: 34,
  homesHit: 1280,
  planTaskId: 't9',
  planStatus: 'draft',
};

const VISITS = [
  {
    id: 'a1',
    kind: 'install',
    title: 'Roof install',
    status: 'scheduled',
    startsAt: '2026-10-16T13:00:00.000Z',
    endsAt: '2026-10-16T21:00:00.000Z',
    allDay: false,
    assigned: { userId: 'u2', name: 'Jess Eaton' },
    customerName: 'Richard Jackson',
    addressLine: '4265 Harney St',
    source: 'front_desk',
  },
  {
    id: 'a2',
    kind: 'inspection',
    title: 'Roof inspection',
    status: 'canceled',
    startsAt: '2026-10-16T14:30:00.000Z',
    endsAt: '2026-10-16T15:30:00.000Z',
    allDay: false,
    assigned: null,
    customerName: 'Robert Walker',
    addressLine: '2406 Harney St',
    source: 'manual',
  },
];

const step = (over: Partial<StepView> = {}): StepView => ({
  id: 's1',
  position: 0,
  type: 'move_appointment',
  approvalClass: 'internal',
  enabled: true,
  version: 3,
  status: 'pending',
  preview: { title: 'Move an install', lines: [] },
  canApprove: true,
  attempts: 0,
  result: null,
  errorPlain: null,
  ...over,
});

let api: ReturnType<typeof stubApi>;

beforeEach(() => {
  // Only Date is faked, so timers and promises still run
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Renders the app at Home with the shell's reads stubbed, plus `own` routes. */
function mountHome(own: Parameters<typeof stubApi>[0] = {}, account: object = DANA) {
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: account }),
    'GET /api/company': () => ({ body: COMPANY_BODY }),
    ...own,
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter({ initialEntries: ['/'] });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, user: userEvent.setup({ advanceTimers: () => undefined }) };
}

describe('Home: the head', () => {
  it('greets by name over the date, the landmark is still Home, and two buttons start the day', async () => {
    mountHome();

    expect(await screen.findByRole('heading', { level: 1, name: 'Good morning, Dana.' })).toBeInTheDocument();
    const main = screen.getByRole('main', { name: 'Home' });
    expect(within(main).getByText('Friday, October 16')).toBeInTheDocument();
    expect(within(main).getByRole('link', { name: home.measureAddress })).toHaveAttribute('href', '/estimator');
    expect(within(main).getByRole('link', { name: home.newJob })).toHaveAttribute('href', '/jobs/new');
    expect(api.unexpected).toEqual([]);
  });
});

describe('Home: the numbers strip', () => {
  it('reads the signed total, the pipeline, the latest hail and the Front Desk week', async () => {
    mountHome({
      'GET /api/home/signed': () => ({
        body: {
          monthTotalCents: 1555300,
          goalCents: null,
          weekly: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 500000, 1055300].map((cents, i) => ({ weekStart: `2026-08-${String(i + 10).padStart(2, '0')}`, totalCents: cents })),
          openPipelineCents: 3292200,
        },
      }),
      'GET /api/jobs/board': () => ({
        body: {
          columns: [
            { stage: 'lead', count: 8, totalCents: null, jobs: [] },
            { stage: 'inspection', count: 4, totalCents: null, jobs: [] },
            { stage: 'proposal', count: 5, totalCents: null, jobs: [] },
            { stage: 'won', count: 1, totalCents: null, jobs: [] },
            { stage: 'installed', count: 40, totalCents: null, jobs: [] },
          ],
          lost: { count: 3 },
        },
      }),
      'GET /api/storms': () => ({ body: { storms: [STORM] } }),
      'GET /api/front-desk/stats': () => ({
        body: { weekStart: '2026-10-12', answered: 7, booked: 6, transferred: 1, messages: 2, spam: 0, firstReplyMsP50: null, guardBlocks: 0, aiMinutesUsed: 4, aiMinutesIncluded: null },
      }),
    });

    const strip = await screen.findByRole('region', { name: home.kpisLabel });
    const tile = (label: string) => within(strip).getByText(label).closest('dl') as HTMLElement;

    expect(await within(strip).findByText('$15,553')).toBeInTheDocument();
    await within(strip).findByText('1.50');
    await within(strip).findByText('$32,922');
    expect(within(tile(home.signed)).getByText(home.signedMeta)).toBeInTheDocument();
    // The twelve weeks behind it, as bars the company's colour ends
    expect(within(strip).getByRole('img', { name: 'Signed each week, last 12 weeks' })).toBeInTheDocument();

    expect(within(tile(home.pipeline)).getByText('$32,922')).toBeInTheDocument();
    // Open jobs are every stage before Installed; Proposal is counted again beside it
    expect(await within(tile(home.pipeline)).findByText(home.pipelineMeta(18, 5))).toBeInTheDocument();

    const hail = tile(home.hail('Tuesday'));
    expect(within(hail).getByText('1.50')).toBeInTheDocument();
    expect(within(hail).getByText('34')).toBeInTheDocument();
    expect(within(hail).getByText(home.hailInside(34))).toBeInTheDocument();

    const desk = tile(home.desk);
    expect(await within(desk).findByText(home.deskMeta(6, 1))).toBeInTheDocument();
    expect(within(desk).getByText('7')).toBeInTheDocument();
    expect(api.unexpected).toEqual([]);
  });

  it('says so, and does not invent a number, when there is no hail and nothing signed', async () => {
    mountHome();

    const strip = await screen.findByRole('region', { name: home.kpisLabel });
    expect(await within(strip).findByText(home.signedNothing)).toBeInTheDocument();
    expect(within(strip).getByText(home.hailNone)).toBeInTheDocument();
    expect(within(strip).getByText(home.hailNoneMeta)).toBeInTheDocument();
    // No weekly bars when no week has anything in it
    expect(within(strip).queryByRole('img')).toBeNull();
  });

  it('shows a goal as a percentage when the company has one', async () => {
    mountHome({
      'GET /api/home/signed': () => ({ body: { monthTotalCents: 1000000, goalCents: 2500000, weekly: [], openPipelineCents: 0 } }),
    });
    expect(await screen.findByText(home.signedGoal(40, '$25,000'))).toBeInTheDocument();
  });

  it('gives a rep no Front Desk tile and never asks for it', async () => {
    mountHome({}, { ...DANA, role: 'rep' });

    const strip = await screen.findByRole('region', { name: home.kpisLabel });
    await within(strip).findByText(home.signedNothing);
    expect(within(strip).queryByText(home.desk)).toBeNull();
    expect(api.count('GET /api/front-desk/stats')).toBe(0);
  });
});

describe('Home: the storm note over the map', () => {
  it('tells how big, where and when, how many were inside and where the plan stands, with a way into the report', async () => {
    mountHome({ 'GET /api/storms': () => ({ body: { storms: [STORM] } }) });

    const note = await screen.findByRole('region', { name: home.stormRegion });
    expect(within(note).getByText('Hail up to 1.5 in crossed West Omaha, NE on Tuesday')).toBeInTheDocument();
    expect(within(note).getByText('34 customers and 1,280 homes inside. Storm Scout drafted a plan.')).toBeInTheDocument();
    expect(within(note).getByRole('link', { name: home.openStormReport })).toHaveAttribute('href', '/storm/s1');
  });

  it('can be dismissed for the visit', async () => {
    const { user } = mountHome({ 'GET /api/storms': () => ({ body: { storms: [STORM] } }) });
    const note = await screen.findByRole('region', { name: home.stormRegion });

    await user.click(within(note).getByRole('button', { name: home.stormDismiss }));
    expect(screen.queryByRole('region', { name: home.stormRegion })).toBeNull();
  });

  it('says when there is no plan yet, and leaves an old storm to the Storm page', async () => {
    mountHome({ 'GET /api/storms': () => ({ body: { storms: [{ ...STORM, planTaskId: null, planStatus: null }] } }) });
    expect(await screen.findByText(/34 customers and 1,280 homes inside\. No plan yet\./)).toBeInTheDocument();
    cleanup();

    mountHome({ 'GET /api/storms': () => ({ body: { storms: [{ ...STORM, day: '2026-10-02' }] } }) });
    await screen.findByRole('region', { name: home.kpisLabel });
    await waitFor(() => expect(api.count('GET /api/storms')).toBe(1));
    expect(screen.queryByRole('region', { name: home.stormRegion })).toBeNull();
    // The numbers strip still names it, by its date
    expect(await screen.findByText(home.hail('Oct 2'))).toBeInTheDocument();
  });
});

describe('Home: the plan waiting for a yes', () => {
  const ONE_STEP = makeTask({
    id: 't1',
    agent: 'scheduler',
    kind: 'weather_moves',
    title: 'Rain on the install day: move 1 install?',
    createdAt: '2026-10-16T16:30:00.000Z',
    expiresAt: '2026-10-19T15:00:00.000Z',
    steps: [step()],
  });
  const MANY_STEPS = makeTask({
    id: 't2',
    title: 'Storm plan for hail near West Omaha',
    createdAt: '2026-10-16T15:00:00.000Z',
    steps: [
      step({ id: 'a', type: 'send_sms_batch', approvalClass: 'message', preview: { title: 'Text 13 customers', lines: [], sendTime: 'today at 10:00 AM' } }),
      step({ id: 'b', type: 'create_ad_campaign', approvalClass: 'spend', preview: { title: 'Google ads', lines: [], maxSpendCents: 14850 } }),
      step({ id: 'c', type: 'create_ad_campaign', approvalClass: 'spend', preview: { title: 'Facebook ads', lines: [], maxSpendCents: 12150 } }),
    ],
  });

  it('shows the newest plan as a card: who drafted it, its facts, and what is left to see', async () => {
    mountHome({ 'GET /api/approvals': () => ({ body: { count: 2, tasks: [MANY_STEPS, ONE_STEP] } }) });

    const card = await screen.findByRole('article', { name: ONE_STEP.title });
    expect(within(card).getByText('Scheduler drafted · 30 min ago')).toBeInTheDocument();
    expect(within(card).getByText(approvals.tagNeedsOk)).toBeInTheDocument();
    expect(within(card).getByText('Expires Mon')).toBeInTheDocument();
    // One more is waiting behind it
    expect(screen.getByText(home.moreWaiting(1))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: home.seeAll })).toHaveAttribute('href', '/approvals');
  });

  it('approves a plan with one decision in one tap, listing the step at the version it saw', async () => {
    const { user } = mountHome({
      'GET /api/approvals': () => ({ body: { count: 1, tasks: [ONE_STEP] } }),
      'POST /api/approvals/t1/approve': () => ({ body: { ...ONE_STEP, status: 'approved' } }),
    });

    const card = await screen.findByRole('article', { name: ONE_STEP.title });
    expect(within(card).getByRole('button', { name: approvals.edit })).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: approvals.approve }));

    await waitFor(() => expect(api.sent('POST /api/approvals/t1/approve')).toEqual([{ steps: [{ id: 's1', version: 3 }] }]));
    expect(await screen.findByText(approvals.approved(ONE_STEP.title))).toBeInTheDocument();
  });

  it('opens the review for a plan with several steps, with the cost it may spend and when it sends', async () => {
    mountHome({ 'GET /api/approvals': () => ({ body: { count: 1, tasks: [MANY_STEPS] } }) });

    const card = await screen.findByRole('article', { name: MANY_STEPS.title });
    expect(within(card).queryByRole('button', { name: approvals.approve })).toBeNull();
    expect(within(card).getByRole('link', { name: approvals.reviewSteps(3) })).toHaveAttribute('href', '/approvals/t2');
    // The most it may spend is the sum of its steps' ceilings
    expect(within(card).getByText('Up to $270')).toBeInTheDocument();
    expect(within(card).getByText('today at 10:00 AM')).toBeInTheDocument();
    expect(within(card).getByText('3')).toBeInTheDocument();
  });

  it('sets a plan aside with an optional reason', async () => {
    const { user } = mountHome({
      'GET /api/approvals': () => ({ body: { count: 1, tasks: [ONE_STEP] } }),
      'POST /api/approvals/t1/decline': () => ({ body: { ...ONE_STEP, status: 'declined' } }),
    });

    const card = await screen.findByRole('article', { name: ONE_STEP.title });
    await user.click(within(card).getByRole('button', { name: approvals.later }));
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('button', { name: approvals.later }));

    await waitFor(() => expect(api.sent('POST /api/approvals/t1/decline')).toEqual([{}]));
    expect(await screen.findByText(approvals.declined)).toBeInTheDocument();
  });

  it('shows a rep no plans: they are for the owner and office', async () => {
    mountHome({ 'GET /api/approvals': () => ({ body: { count: 1, tasks: [ONE_STEP] } }) }, { ...DANA, role: 'rep' });

    await screen.findByRole('region', { name: home.kpisLabel });
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('draws no card when nothing waits', async () => {
    mountHome();
    await screen.findByRole('region', { name: home.kpisLabel });
    expect(screen.queryByRole('article')).toBeNull();
  });
});

describe("Home: today's visits", () => {
  it('lists the visits that are on, earliest first, with the time, who and where, and the person going', async () => {
    mountHome({ 'GET /api/appointments?*': () => ({ body: { appointments: VISITS, busy: [] } }) });

    // The list first draws ghost rows while the visits load
    await screen.findByText('Install · Richard Jackson');
    const list = screen.getByRole('list', { name: home.visitsLabel });
    const rows = within(list).getAllByRole('listitem');
    // The canceled inspection is not today's work
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText('8:00')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('AM')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Install · Richard Jackson')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('4265 Harney St · from Front Desk')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Jess Eaton')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('link')).toHaveAttribute('href', '/calendar/appointments/a1');
    const panel = screen.getByRole('region', { name: new RegExp(`^${home.todayTitle}`) });
    expect(within(panel).getByText(home.visits(1))).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: new RegExp(home.calendar) })).toHaveAttribute('href', '/calendar');
  });

  it('asks for the company day in its own time zone', async () => {
    mountHome();
    await screen.findByText(home.noVisits);
    // Midnight to midnight in Chicago on Friday, October 16 (CDT is UTC-5)
    expect(api.calls.map((call) => call.key)).toContain(
      'GET /api/appointments?from=2026-10-16T05%3A00%3A00.000Z&to=2026-10-17T05%3A00%3A00.000Z&withBusy=true',
    );
  });

  it('with no visits shows what a day looks like, how many leads have no inspection, and a way to book one', async () => {
    mountHome({
      'GET /api/jobs/board': () => ({ body: { columns: [{ stage: 'lead', count: 3, totalCents: null, jobs: [] }], lost: { count: 0 } } }),
    });

    expect(await screen.findByText(home.noVisits)).toBeInTheDocument();
    expect(await screen.findByText(home.noVisitsLeads(3))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: home.bookVisit })).toHaveAttribute('href', '/calendar/new');
  });
});

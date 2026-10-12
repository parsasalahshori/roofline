import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JobView } from '@roofline/shared';
import type { Account } from '../src/api/types.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { job } from '../src/copy/job.ts';
import { jobs } from '../src/copy/jobs.ts';
import { formatDollars } from '../src/features/jobs/JobCardView.tsx';
import { ACCOUNT, type Routes, SHELL_ROUTES, stubApi } from './helpers.tsx';

// Phone and desktop differ only in the layout; these tests stay on desktop.
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

// The timeline has its own tests; here it only has to mount with the job's id.
vi.mock('../src/features/timeline/Timeline.tsx', async () => {
  const { createElement } = await import('react');
  return {
    Timeline: (props: { jobId?: string }) =>
      createElement('div', { 'data-testid': 'timeline-mock', 'data-job-id': props.jobId }),
  };
});

const REP_ACCOUNT: Account = { ...ACCOUNT, role: 'rep' };

let api: ReturnType<typeof stubApi>;
/** What `GET /api/jobs/j1/view` answers right now. */
let current: JobView;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  phoneMode.phone = false;
  expect(api?.unexpected ?? []).toEqual([]);
});

/** A full job view. Pass the parts that differ; `job` and `can` merge one level deep. */
function view(overrides: Partial<Omit<JobView, 'job' | 'can'>> & { job?: Partial<JobView['job']>; can?: Partial<JobView['can']> } = {}): JobView {
  const { job: jobOverrides, can: canOverrides, ...rest } = overrides;
  return {
    job: {
      id: 'j1',
      customerId: 'c1',
      customerName: 'Pat Homeowner',
      propertyId: 'p1',
      addressLine: '12 Oak St',
      stage: 'inspection',
      valueCents: 1425000,
      assigned: null,
      daysInStage: 3,
      stuck: false,
      nextStep: 'Call adjuster',
      nextStepOn: '2026-10-14',
      updatedAt: '2026-10-10T12:00:00.000Z',
      source: 'call',
      lostReason: null,
      stageChangedAt: '2026-10-09T12:00:00.000Z',
      archived: false,
      createdAt: '2026-10-01T12:00:00.000Z',
      ...jobOverrides,
    },
    customer: { id: 'c1', displayName: 'Pat Homeowner', phone: null, email: null },
    home: {
      id: 'p1',
      addressLine: '12 Oak St',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      located: true,
      jobs: [{ id: 'j1', stage: 'inspection' }],
    },
    appointments: [
      {
        id: 'a1',
        kind: 'inspection',
        status: 'scheduled',
        startsAt: '2026-10-14T15:00:00.000Z',
        endsAt: '2026-10-14T16:00:00.000Z',
        allDay: false,
        assigned: { userId: 'u1', name: 'Sam Roofer' },
      },
    ] as unknown as JobView['appointments'],
    quotes: [{ id: 'q1', number: 'Q-0001', status: 'draft', totalCents: 1425000, updatedAt: '2026-10-10T12:00:00.000Z' }] as unknown as JobView['quotes'],
    tasks: [{ id: 't1', title: 'Follow up with Pat', status: 'awaiting_owner' }] as unknown as JobView['tasks'],
    ...rest,
    can: { edit: true, seeValue: true, archive: true, ...canOverrides },
  } as JobView;
}

/** A signed-in person whose job window answers from `current`. Pass what the test sends or expects. */
function signedIn(job: JobView, overrides: Routes = {}, account = ACCOUNT) {
  current = job;
  api = stubApi({
    ...SHELL_ROUTES,
    'GET /api/auth/me': () => ({ body: account }),
    'GET /api/team': () => ({
      body: {
        members: [{ id: 'm1', userId: 'u1', name: 'Sam Roofer', email: 'sam@example.com', role: 'owner', canApproveSpend: true, status: 'active' }],
        invites: [],
      },
    }),
    'GET /api/company': () => ({ body: { id: 'c1', name: 'Summit Roofing', timezone: 'America/Chicago' } }),
    'GET /api/jobs/j1/view': () => ({ body: current }),
    'GET /api/jobs/j1/claim': () => ({ body: { claim: null, intake: null, packet: null } }),
    'GET /api/proposals?jobId=j1': () => ({ body: { proposals: [], total: 0 } }),
    ...overrides,
  });
  return api;
}

function renderJob(path = '/jobs/j1') {
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

const stepper = () => screen.findByRole('group', { name: job.stepperLabel });

describe('job window', () => {
  it('renders the view', async () => {
    signedIn(view());
    renderJob();

    const customer = await screen.findByRole('link', { name: 'Pat Homeowner' });
    expect(customer).toHaveAttribute('href', '/customers/c1');

    const address = screen.getByRole('link', { name: job.addressLink('12 Oak St') });
    expect(address).toHaveAttribute('href', '/?focus=p1');

    const steps = within(await stepper());
    expect(steps.getByRole('button', { name: jobs.stage.inspection })).toHaveAttribute('data-current', 'true');
    expect(screen.getAllByText(jobs.stage.inspection).length).toBeGreaterThan(0);

    expect(screen.getByText(formatDollars(1425000))).toBeInTheDocument();
    expect(screen.getByText('$14,250')).toBeInTheDocument();
    expect(screen.getByText(job.daysInStage(3))).toBeInTheDocument();
    expect(screen.getByText('3 days')).toBeInTheDocument();

    const quote = screen.getByRole('link', { name: /Q-0001/ });
    expect(quote).toHaveAttribute('href', '/jobs/j1/quotes/q1');
    expect(quote).toHaveTextContent('Q-0001');

    const task = screen.getByRole('link', { name: /Follow up with Pat/ });
    expect(task).toHaveAttribute('href', '/approvals/t1');
  });

  it('a rep sees no value', async () => {
    signedIn(view({ job: { valueCents: null }, can: { seeValue: false } }), {}, REP_ACCOUNT);
    renderJob();

    await screen.findByRole('link', { name: 'Pat Homeowner' });
    // The quote carries a total of $14,250 in the data, but a rep may not see it
    expect(screen.getByRole('link', { name: /Q-0001/ })).toBeInTheDocument();
    expect(screen.queryByText('$14,250')).not.toBeInTheDocument();
    expect(screen.queryByText(job.statValue)).not.toBeInTheDocument();
    expect(screen.queryByText(/Estimate/)).not.toBeInTheDocument();
  });

  it('stepper click to Proposal sends PATCH', async () => {
    signedIn(view(), {
      'PATCH /api/jobs/j1': () => ({ body: {} }),
    });
    const { user } = renderJob();

    const steps = within(await stepper());
    await user.click(steps.getByRole('button', { name: jobs.stage.proposal }));

    await vi.waitFor(() => expect(api.count('PATCH /api/jobs/j1')).toBe(1));
    expect(api.sent('PATCH /api/jobs/j1')).toEqual([{ stage: 'proposal' }]);
  });

  it('Lost via stepper opens the sheet', async () => {
    signedIn(view(), {
      'PATCH /api/jobs/j1': () => ({ body: {} }),
    });
    const { user } = renderJob();

    const steps = within(await stepper());
    const lost = steps.getByRole('button', { name: jobs.stage.lost });
    expect(lost).toHaveAttribute('data-stage', 'lost');
    await user.click(lost);

    expect(await screen.findByRole('dialog', { name: jobs.sheetLost })).toBeVisible();
    expect(api.count('PATCH /api/jobs/j1')).toBe(0);
  });

  it('Book inspection link URL', async () => {
    signedIn(view());
    renderJob();

    const inspection = await screen.findByRole('link', { name: job.bookInspection });
    expect(inspection).toHaveAttribute('href', '/calendar/new?jobId=j1&kind=inspection');
    expect(screen.getByRole('link', { name: job.bookInstall })).toHaveAttribute('href', '/calendar/new?jobId=j1&kind=install');
  });

  it('the timeline mounts with jobId', async () => {
    signedIn(view());
    renderJob();

    const timeline = await screen.findByTestId('timeline-mock');
    expect(timeline).toHaveAttribute('data-job-id', 'j1');
  });

  it('404 shows the Not found empty state', async () => {
    signedIn(view(), {
      'GET /api/jobs/j1/view': () => ({ status: 404, body: { error: 'Not found' } }),
    });
    renderJob();

    expect(await screen.findByText(job.notFoundTitle)).toBeVisible();
    expect(screen.getByText(job.notFoundBody)).toBeInTheDocument();
  });

  it('edit sheet sends only the changed value in cents', async () => {
    signedIn(view(), {
      'PATCH /api/jobs/j1': () => ({ body: {} }),
    });
    const { user } = renderJob();

    await user.click(await screen.findByRole('button', { name: job.edit }));
    const sheet = within(await screen.findByRole('dialog', { name: job.editTitle }));
    const value = sheet.getByLabelText(job.valueLabel);
    await user.clear(value);
    await user.type(value, '15,000');
    await user.click(sheet.getByRole('button', { name: job.save }));

    await vi.waitFor(() => expect(api.count('PATCH /api/jobs/j1')).toBe(1));
    expect(api.sent('PATCH /api/jobs/j1')).toEqual([{ valueCents: 1500000 }]);
  });

  it('edit sheet rejects a bad amount', async () => {
    signedIn(view(), {
      'PATCH /api/jobs/j1': () => ({ body: {} }),
    });
    const { user } = renderJob();

    await user.click(await screen.findByRole('button', { name: job.edit }));
    const sheet = within(await screen.findByRole('dialog', { name: job.editTitle }));
    const value = sheet.getByLabelText(job.valueLabel);
    await user.clear(value);
    await user.type(value, 'abc');
    await user.click(sheet.getByRole('button', { name: job.save }));

    expect(await sheet.findByText(job.valueInvalid)).toBeInTheDocument();
    expect(api.count('PATCH /api/jobs/j1')).toBe(0);
  });

  it('archive asks first, then posts', async () => {
    signedIn(view(), {
      'POST /api/jobs/j1/archive': () => ({ body: {} }),
    });
    const { user } = renderJob();

    await user.click(await screen.findByRole('button', { name: job.edit }));
    const sheet = within(await screen.findByRole('dialog', { name: job.editTitle }));
    await user.click(sheet.getByRole('button', { name: job.archive }));
    expect(api.count('POST /api/jobs/j1/archive')).toBe(0);

    await user.click(await sheet.findByRole('button', { name: job.confirm }));
    await vi.waitFor(() => expect(api.count('POST /api/jobs/j1/archive')).toBe(1));
  });

  it('a rep edits without a value field', async () => {
    signedIn(view({ job: { valueCents: null }, can: { seeValue: false } }), {}, REP_ACCOUNT);
    const { user } = renderJob();

    await user.click(await screen.findByRole('button', { name: job.edit }));
    const sheet = within(await screen.findByRole('dialog', { name: job.editTitle }));
    expect(sheet.queryByLabelText(job.valueLabel)).not.toBeInTheDocument();
  });
});

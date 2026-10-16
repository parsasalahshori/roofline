import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// RouterProvider from 'react-router', not 'react-router/dom': under Vitest the two load as separate copies of the router
import { RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localDate, type JobView } from '@roofline/shared';
import type { Account } from '../src/api/types.ts';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { createAppRouter } from '../src/app/router.tsx';
import { job } from '../src/copy/job.ts';
import { appointments } from '../src/copy/appointments.ts';
import { claims } from '../src/copy/claims.ts';
import { jobs } from '../src/copy/jobs.ts';
import { formatDollars } from '../src/features/jobs/format.ts';
import { chooseChip } from './crm-helpers.ts';
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

const PHONE = '+14025550144';
const withContact = (extra: Partial<JobView['customer']> = {}) => ({
  customer: { id: 'c1', displayName: 'Pat Homeowner', phone: PHONE, email: 'pat@example.com', ...extra },
});
const CLAIM = {
  id: 'cl1',
  jobId: 'j1',
  insurer: 'Acme Mutual',
  claimNumber: null,
  dateOfLoss: null,
  status: 'filed',
  adjusterName: null,
  adjusterPhone: null,
  adjusterEmail: null,
  adjusterAppointmentId: null,
  deductibleCents: null,
  notes: null,
  statusChangedAt: '2026-10-14T15:00:00.000Z',
  events: [],
};

/** The page's main, found by its title: the name of the customer. */
const page = async () => within(await screen.findByRole('main', { name: 'Pat Homeowner' }));

describe('job page head', () => {
  it('the customer is the title; Jobs is in the trail', async () => {
    signedIn(view());
    renderJob();

    expect(await screen.findByRole('heading', { level: 1, name: 'Pat Homeowner' })).toBeInTheDocument();
    const trail = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(trail.getByRole('link', { name: 'Jobs' })).toHaveAttribute('href', '/jobs');
    expect(trail.getByText('Pat Homeowner')).toBeInTheDocument();
  });

  it('under the title: the address, which opens the map, and the phone', async () => {
    signedIn(view(withContact()));
    renderJob();

    const main = await page();
    expect(main.getByRole('link', { name: job.addressLink('12 Oak St') })).toHaveAttribute('href', '/?focus=p1');
    expect(main.getByText(job.addressRest('Austin', 'TX', '78701'))).toBeInTheDocument();
    const number = main.getByRole('link', { name: '(402) 555-0144' });
    expect(number).toHaveAttribute('href', `tel:${PHONE}`);
  });

  it('Call, Text and Directions go where the customer is', async () => {
    signedIn(view(withContact()));
    renderJob();

    const actions = within(await screen.findByRole('group', { name: job.actionsLabel }));
    expect(actions.getByRole('link', { name: job.call })).toHaveAttribute('href', `tel:${PHONE}`);
    expect(actions.getByRole('link', { name: job.text })).toHaveAttribute('href', `sms:${PHONE}`);
    const directions = actions.getByRole('link', { name: job.directions });
    expect(directions.getAttribute('href')).toBe(
      `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent('12 Oak St, Austin, TX 78701')}`,
    );
    expect(directions).toHaveAttribute('target', '_blank');
    expect(directions).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('a customer with no phone has no Call or Text, and no dead button in their place', async () => {
    signedIn(view());
    renderJob();

    const actions = within(await screen.findByRole('group', { name: job.actionsLabel }));
    expect(actions.queryByRole('link', { name: job.call })).not.toBeInTheDocument();
    expect(actions.queryByRole('link', { name: job.text })).not.toBeInTheDocument();
    expect(actions.getByRole('link', { name: job.directions })).toBeInTheDocument();
  });

  it('marks an insurance claim', async () => {
    signedIn(view(), { 'GET /api/jobs/j1/claim': () => ({ body: { claim: CLAIM, intake: null, packet: null } }) });
    renderJob();

    const main = await page();
    expect(await main.findAllByText(job.insuranceClaim)).not.toHaveLength(0);
    // The tag under the name is not the panel's heading
    expect(main.getAllByText(job.insuranceClaim).some((node) => node.closest('p') !== null)).toBe(true);
  });

  it('no claim, no tag', async () => {
    signedIn(view());
    renderJob();

    const main = await page();
    await main.findByText(claims.none);
    expect(main.queryByText(job.insuranceClaim, { selector: 'span' })).not.toBeInTheDocument();
  });

  it('says Archived in a tag when the job is archived', async () => {
    signedIn(view({ job: { archived: true } }));
    renderJob();

    expect(await (await page()).findByText(job.archivedChip)).toBeInTheDocument();
  });

  it('the quick move is the next stage, and it moves the job there', async () => {
    signedIn(view(), { 'PATCH /api/jobs/j1': () => ({ body: {} }) });
    const { user } = renderJob();

    await user.click(await screen.findByRole('button', { name: jobs.moveToStage(jobs.stage.proposal) }));
    await vi.waitFor(() => expect(api.count('PATCH /api/jobs/j1')).toBe(1));
    expect(api.sent('PATCH /api/jobs/j1')).toEqual([{ stage: 'proposal' }]);
  });

  it('beside it, the stage menu is still named Move to…', async () => {
    signedIn(view());
    renderJob();

    expect(await screen.findByRole('button', { name: jobs.moveTo })).toHaveAttribute('aria-haspopup', 'listbox');
  });

  it('a lost job has the stage menu and no quick move', async () => {
    signedIn(view({ job: { stage: 'lost', lostReason: 'Price' } }));
    renderJob();

    await screen.findByRole('button', { name: jobs.moveTo });
    expect(screen.queryByRole('button', { name: /^Move to (Lead|Inspection|Proposal|Won|Installed)$/ })).not.toBeInTheDocument();
  });

  it('a person who cannot edit has no move controls', async () => {
    signedIn(view({ can: { edit: false } }));
    renderJob();

    await page();
    expect(screen.queryByRole('button', { name: jobs.moveTo })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: job.edit })).not.toBeInTheDocument();
  });
});

describe('the stage steps', () => {
  it('five steps: those behind the job, the one it is in with its days, and those ahead', async () => {
    signedIn(view());
    renderJob();

    const steps = await stepper();
    const segments = Array.from(steps.querySelectorAll('[data-step]'));
    expect(segments.map((segment) => segment.getAttribute('data-step'))).toEqual(['lead', 'inspection', 'proposal', 'won', 'installed']);
    expect(segments.map((segment) => segment.getAttribute('data-state'))).toEqual(['done', 'current', 'todo', 'todo', 'todo']);
    expect(within(segments[1] as HTMLElement).getByText(job.daysInStage(3))).toBeInTheDocument();
    expect(within(steps).getAllByText(/days?$/)).toHaveLength(1);
  });

  it('Installed can only be chosen from Won', async () => {
    signedIn(view());
    renderJob();

    expect(within(await stepper()).getByRole('button', { name: jobs.stage.installed })).toBeDisabled();
  });

  it('from Won, Installed can be chosen', async () => {
    signedIn(view({ job: { stage: 'won' } }));
    renderJob();

    expect(within(await stepper()).getByRole('button', { name: jobs.stage.installed })).toBeEnabled();
  });

  it('a lost job says Lost and why, and every step is ahead of it', async () => {
    signedIn(view({ job: { stage: 'lost', lostReason: 'Price' } }));
    renderJob();

    const steps = await stepper();
    expect(screen.getByText(job.lostWhy('Price'))).toBeInTheDocument();
    expect(within(steps).queryByRole('button', { name: jobs.stage.lost })).not.toBeInTheDocument();
    const states = Array.from(steps.querySelectorAll('[data-step]')).map((segment) => segment.getAttribute('data-state'));
    expect(states).toEqual(['todo', 'todo', 'todo', 'todo', 'todo']);
  });

  it('a person who cannot edit sees the steps and cannot press them', async () => {
    signedIn(view({ can: { edit: false } }));
    renderJob();

    const steps = within(await stepper());
    for (const button of steps.getAllByRole('button')) expect(button).toBeDisabled();
  });
});

describe('the next step', () => {
  const card = async () => within(await screen.findByRole('region', { name: job.nextStepLabel }));

  it('the step, its day and the rep', async () => {
    signedIn(view({ job: { nextStep: 'Call adjuster', nextStepOn: '2099-10-14', assigned: { userId: 'u1', name: 'Sam Roofer' } } }));
    renderJob();

    const next = await card();
    expect(next.getByText('Call adjuster')).toBeInTheDocument();
    expect(next.getByText(job.nextStepMeta(['Oct 14', 'Sam Roofer']))).toBeInTheDocument();
    expect(next.queryByText(job.overdue)).not.toBeInTheDocument();
  });

  it("says Today and Tomorrow in words", async () => {
    const today = localDate(new Date(), 'America/Chicago');
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    signedIn(view({ job: { nextStep: 'Call adjuster', nextStepOn: today } }));
    renderJob();
    expect(await (await card()).findByText(job.today)).toBeInTheDocument();
    cleanup();

    signedIn(view({ job: { nextStep: 'Call adjuster', nextStepOn: tomorrow } }));
    renderJob();
    expect(await (await card()).findByText(job.tomorrow)).toBeInTheDocument();
  });

  it('a step whose day has gone by says Overdue, in words', async () => {
    signedIn(view({ job: { nextStep: 'Call adjuster', nextStepOn: '2020-01-02' } }));
    renderJob();

    const next = await card();
    expect(next.getByText(job.overdue)).toBeInTheDocument();
    expect(next.getByText('Jan 2')).toBeInTheDocument();
  });

  it('with no step it says so, and offers to add one', async () => {
    signedIn(view({ job: { nextStep: null, nextStepOn: null } }));
    const { user } = renderJob();

    const next = await card();
    expect(next.getByText(job.nextStepNone)).toBeInTheDocument();
    await user.click(next.getByRole('button', { name: job.nextStepAdd }));
    expect(await screen.findByRole('dialog', { name: job.editTitle })).toBeVisible();
  });

  it('a person who cannot edit is not offered to add one', async () => {
    signedIn(view({ job: { nextStep: null, nextStepOn: null }, can: { edit: false } }));
    renderJob();

    expect((await card()).queryByRole('button', { name: job.nextStepAdd })).not.toBeInTheDocument();
  });
});

describe('the details', () => {
  const panel = async () => within(await screen.findByRole('region', { name: job.detailsTitle }));

  it('the customer is a link; then email, source, value and the two dates', async () => {
    signedIn(view(withContact()));
    renderJob();

    const details = await panel();
    expect(details.getByRole('link', { name: 'Pat Homeowner' })).toHaveAttribute('href', '/customers/c1');
    expect(details.getByRole('link', { name: 'pat@example.com' })).toHaveAttribute('href', 'mailto:pat@example.com');
    expect(details.getByText(job.sourceLabel).nextElementSibling).toHaveTextContent(jobs.source.call);
    expect(details.getByText(job.statValue).nextElementSibling).toHaveTextContent('$14,250');
    expect(details.getByText(job.sinceLabel).nextElementSibling).toHaveTextContent('Oct 9');
    expect(details.getByText(job.createdLabel).nextElementSibling).toHaveTextContent('Oct 1');
  });

  it('no email, no row for it; no value for a rep, no row for it', async () => {
    signedIn(view({ job: { valueCents: null }, can: { seeValue: false } }), {}, REP_ACCOUNT);
    renderJob();

    const details = await panel();
    expect(details.queryByText(job.emailLabel)).not.toBeInTheDocument();
    expect(details.queryByText(job.statValue)).not.toBeInTheDocument();
  });

  it('Edit is in the panel and opens the sheet', async () => {
    signedIn(view());
    const { user } = renderJob();

    await user.click((await panel()).getByRole('button', { name: job.edit }));
    expect(await screen.findByRole('dialog', { name: job.editTitle })).toBeVisible();
  });

  it('the rep is a chip that hands the job to someone else', async () => {
    signedIn(view(), { 'PATCH /api/jobs/j1': () => ({ body: {} }) });
    const { user } = renderJob();

    await panel();
    await chooseChip(user, job.repLabel, job.unassigned, 'Sam Roofer');
    await vi.waitFor(() => expect(api.count('PATCH /api/jobs/j1')).toBe(1));
    expect(api.sent('PATCH /api/jobs/j1')).toEqual([{ assignedUserId: 'u1' }]);
  });

  it('a person who cannot edit sees who has the job as text, with no chip', async () => {
    signedIn(view({ job: { assigned: { userId: 'u1', name: 'Sam Roofer' } }, can: { edit: false } }));
    renderJob();

    const details = await panel();
    expect(details.getByText(job.repLabel).nextElementSibling).toHaveTextContent('Sam Roofer');
    expect(details.queryByRole('button', { name: /^Rep:/ })).not.toBeInTheDocument();
  });
});

describe('visits, quotes and agent tasks', () => {
  it('a visit is a link to its page, with when and who', async () => {
    signedIn(view());
    renderJob();

    const visits = within(await screen.findByRole('region', { name: job.appointmentsTitle }));
    const link = visits.getByRole('link', { name: /Inspection/ });
    expect(link).toHaveAttribute('href', '/calendar/appointments/a1');
    expect(link).toHaveTextContent('Sam Roofer');
    expect(link).toHaveTextContent('Oct 14, 2026');
  });

  it('a canceled visit says Canceled in a tag', async () => {
    signedIn(view({ appointments: [{ id: 'a1', kind: 'install', status: 'canceled', startsAt: '2026-10-14T15:00:00.000Z', endsAt: '2026-10-14T16:00:00.000Z', allDay: false, assigned: null }] as unknown as JobView['appointments'] }));
    renderJob();

    const visits = within(await screen.findByRole('region', { name: job.appointmentsTitle }));
    expect(visits.getByText(appointments.status.canceled)).toBeInTheDocument();
    expect(visits.getByText(jobs.unassigned)).toBeInTheDocument();
  });

  it('with no visits, the panel says so and the buttons that book them stay in its header', async () => {
    signedIn(view({ appointments: [] }));
    renderJob();

    const visits = within(await screen.findByRole('region', { name: job.appointmentsTitle }));
    expect(visits.getByText(job.appointmentsEmpty)).toBeInTheDocument();
    expect(visits.getByRole('link', { name: job.bookInspection })).toBeInTheDocument();
  });

  it('a quote says Draft or Final in a tag, with its total', async () => {
    signedIn(
      view({
        quotes: [
          { id: 'q1', number: 'Q-0001', status: 'draft', totalCents: 1425000, updatedAt: '2026-10-10T12:00:00.000Z' },
          { id: 'q2', number: 'Q-0002', status: 'final', totalCents: 1500000, updatedAt: '2026-10-11T12:00:00.000Z' },
        ] as unknown as JobView['quotes'],
      }),
    );
    renderJob();

    const quotes = within(await screen.findByRole('region', { name: job.quotesTitle }));
    expect(quotes.getByRole('link', { name: /Q-0001/ })).toHaveTextContent(job.quoteStatus.draft);
    expect(quotes.getByRole('link', { name: /Q-0002/ })).toHaveTextContent(job.quoteStatus.final);
    expect(quotes.getByRole('link', { name: /Q-0002/ })).toHaveTextContent(job.quoteTotal('$15,000'));
  });

  it('with no quotes or tasks, each panel says so', async () => {
    signedIn(view({ quotes: [], tasks: [] }));
    renderJob();

    expect(await screen.findByText(job.quotesEmpty)).toBeInTheDocument();
    expect(screen.getByText(job.tasksEmpty)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: job.newQuote })).toBeInTheDocument();
  });
});

describe('loading and failing', () => {
  it('while it loads, a status names the wait and the page is already titled Jobs', async () => {
    signedIn(view(), { 'GET /api/jobs/j1/view': () => new Promise(() => undefined) as never });
    renderJob();

    expect(await screen.findByRole('status', { name: job.loading })).toBeInTheDocument();
    expect(screen.getByRole('main', { name: 'Jobs' })).toBeInTheDocument();
  });

  it('a failed load says so, in place, with Try again', async () => {
    let calls = 0;
    signedIn(view(), {
      'GET /api/jobs/j1/view': () => {
        calls += 1;
        return calls <= 2 ? { status: 500, body: { error: 'x' } } : { body: current };
      },
    });
    const { user } = renderJob();

    const alert = (await screen.findByText(job.loadFailed, undefined, { timeout: 8000 })).closest('[role="alert"]');
    expect(alert).not.toBeNull();
    await user.click(within(alert as HTMLElement).getByRole('button', { name: job.retry }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Pat Homeowner' })).toBeInTheDocument();
  });

  it('a job that is not there has a way back to Jobs', async () => {
    signedIn(view(), { 'GET /api/jobs/j1/view': () => ({ status: 404, body: { error: 'Not found' } }) });
    renderJob();

    expect(await screen.findByRole('link', { name: job.backToJobs })).toHaveAttribute('href', '/jobs');
  });
});

describe('on a phone', () => {
  it('Call, Text and Directions are tiles under the steps, and the header has none of them', async () => {
    phoneMode.phone = true;
    signedIn(view(withContact()));
    renderJob();

    const tiles = within(await screen.findByRole('group', { name: job.tilesLabel }));
    expect(tiles.getByRole('link', { name: job.call })).toHaveAttribute('href', `tel:${PHONE}`);
    expect(tiles.getByRole('link', { name: job.text })).toBeInTheDocument();
    expect(tiles.getByRole('link', { name: job.directions })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: job.actionsLabel })).not.toBeInTheDocument();
  });

  it('the way back is Jobs, and the stage menu is beside it with its label', async () => {
    phoneMode.phone = true;
    signedIn(view());
    renderJob();

    const main = await page();
    expect(main.getByRole('link', { name: 'Jobs' })).toHaveAttribute('href', '/jobs');
    expect(main.getByRole('button', { name: jobs.moveTo })).toHaveAttribute('data-labelled', 'true');
    // The phone has no quick move: the stage menu is the one control
    expect(main.queryByRole('button', { name: jobs.moveToStage(jobs.stage.proposal) })).not.toBeInTheDocument();
  });

  it('the phone number is not repeated under the name: the Call tile has it', async () => {
    phoneMode.phone = true;
    signedIn(view(withContact()));
    renderJob();

    const main = await page();
    expect(main.queryByRole('link', { name: '(402) 555-0144' })).not.toBeInTheDocument();
  });
});

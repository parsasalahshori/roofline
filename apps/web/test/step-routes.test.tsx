import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stepTypes } from '@roofline/shared';
import type { StepView } from '../src/api/types.ts';
import { stepRoutes } from '../src/copy/stepRoutes.ts';
import { BuildRoutesPreview, buildRoutesKit } from '../src/features/approvals/steps/BuildRoutesPreview.tsx';
import { renderAt, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi> | undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
  api = undefined;
});

const COMPANY_STORM_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REP_A = '1b4e28ba-2fa3-41ed-a261-0242ac120002';
const REP_B = '7d9e4b2a-5c1f-4e8a-9b3d-6f2a1c0e8d7b';

/** A build_routes step as the server sends it: two reps, up to 60 doors. */
function routesStep(overrides: Partial<StepView> = {}): StepView {
  return {
    id: 's2',
    position: 2,
    type: 'build_routes',
    approvalClass: 'internal',
    enabled: true,
    version: 1,
    status: 'pending',
    preview: {
      title: '2 door-knock routes · 60 doors',
      lines: ['Rep 1: 1 route, up to 30 doors', 'Rep 2: 1 route, up to 30 doors'],
    },
    canApprove: true,
    attempts: 0,
    result: null,
    errorPlain: null,
    payload: { companyStormId: COMPANY_STORM_ID, repUserIds: [REP_A, REP_B], maxDoors: 60 },
    ...overrides,
  };
}

/** The team, with the first rep on it and the second one gone. */
function teamStub() {
  return stubApi({
    'GET /api/team': () => ({
      body: {
        members: [
          {
            id: 'm1',
            userId: REP_A,
            name: 'Ana Lopez',
            email: 'ana@example.com',
            role: 'rep',
            canApproveSpend: false,
            status: 'active',
            stormAlertEmail: false,
          },
        ],
        invites: [],
      },
    }),
  });
}

describe('build_routes preview', () => {
  it('shows the title, both routes and the door cap', async () => {
    api = teamStub();
    renderAt(<BuildRoutesPreview step={routesStep()} canApprove />);

    expect(screen.getByRole('heading', { name: '2 door-knock routes · 60 doors' })).toBeInTheDocument();
    expect(screen.getAllByText('1 route, up to 30 doors')).toHaveLength(2);
    expect(screen.getByText(stepRoutes.doorsCap(60))).toBeInTheDocument();
    expect(await screen.findByText('Ana Lopez')).toBeInTheDocument();
  });

  it('names an unknown rep by position and shows no addresses', async () => {
    api = teamStub();
    renderAt(<BuildRoutesPreview step={routesStep()} canApprove />);

    expect(await screen.findByText('Ana Lopez')).toBeInTheDocument();
    expect(screen.getByText(stepRoutes.repFallback(1))).toBeInTheDocument();
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('is the kit\'s Preview and the review reads the step\'s own preview', () => {
    const step = routesStep();
    expect(buildRoutesKit.Preview).toBe(BuildRoutesPreview);
    expect(buildRoutesKit.review(step)).toEqual(step.preview);
  });
});

describe('build_routes edit', () => {
  it('lists the reps and the door cap as the fields to edit', () => {
    const fields = buildRoutesKit.editFields(routesStep());
    expect(fields).toEqual([
      { id: 'reps', label: stepRoutes.repsLabel, kind: 'pick', value: [REP_A, REP_B], options: [] },
      { id: 'maxDoors', label: stepRoutes.doorsLabel, kind: 'number', value: '60' },
    ]);
  });

  it('swaps in the edited reps and door cap and keeps the company storm', () => {
    const payload = buildRoutesKit.toPayload(routesStep(), { reps: [REP_B], maxDoors: '45' });
    expect(payload).toEqual({ companyStormId: COMPANY_STORM_ID, repUserIds: [REP_B], maxDoors: 45 });
  });

  it('asks for at least one rep when none is picked', () => {
    expect(buildRoutesKit.fieldErrors?.(routesStep(), { reps: [], maxDoors: '60' })).toEqual({
      reps: stepRoutes.pickOneRep,
    });
    expect(buildRoutesKit.fieldErrors?.(routesStep(), { reps: [REP_A], maxDoors: '60' })).toEqual({});
  });

  it('produces a payload the shared build_routes schema accepts', () => {
    const payload = buildRoutesKit.toPayload(routesStep(), { reps: [REP_A], maxDoors: '60' });
    expect(stepTypes.build_routes.payload.safeParse(payload).success).toBe(true);
  });
});

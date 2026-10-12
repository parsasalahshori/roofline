import { cleanup, screen, waitFor } from '@testing-library/react';
import { hoursLabel } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { timeBaselines } from '../src/copy/agents.ts';
import { agentsKeys } from '../src/features/agents/api.ts';
import { RecountSection } from '../src/features/agents/RecountSection.tsx';
import { renderAt, stubApi } from './helpers.tsx';

const DRY = 'POST /api/agents/time-baselines/recount?dryRun=1';
const REAL = 'POST /api/agents/time-baselines/recount';
const RESULT = { from: '2026-07-14', to: '2026-10-12', beforeMinutes: 1860, afterMinutes: 1620, steps: 412 };

let api: ReturnType<typeof stubApi>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
});

function setup(canRecount = true, dry: { status?: number; body?: unknown } = { body: { dryRun: true, ...RESULT } }) {
  api = stubApi({ [DRY]: () => dry, [REAL]: () => ({ body: { dryRun: false, ...RESULT } }) });
  return renderAt(<RecountSection canRecount={canRecount} />);
}

const before = `${timeBaselines.recountBefore} ${hoursLabel(1860)} ${timeBaselines.estimate}`;
const after = `${timeBaselines.recountAfter} ${hoursLabel(1620)} ${timeBaselines.estimate}`;

describe('recount section', () => {
  it('owner recount runs a dry run first and shows before and after', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: timeBaselines.recountButton }));
    expect(await screen.findByText(before)).toBeInTheDocument();
    expect(screen.getByText(after)).toBeInTheDocument();
    expect(screen.getByText(`${timeBaselines.recountSteps} 412`)).toBeInTheDocument();
    expect(before).toContain('about');
    expect(after).toContain('(estimate)');
    expect(api.calls.map((call) => call.key)).toEqual([DRY]);
  });

  it('Confirm runs the real recount, then shows the success line and invalidates agents queries', async () => {
    const { user, queryClient } = setup();
    await queryClient.prefetchQuery({ queryKey: agentsKeys.all, queryFn: () => 1 });
    await user.click(screen.getByRole('button', { name: timeBaselines.recountButton }));
    await user.click(await screen.findByRole('button', { name: timeBaselines.recountConfirm }));
    await waitFor(() => expect(api.count(REAL)).toBe(1));
    expect(await screen.findByText(timeBaselines.recountDone)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(queryClient.getQueryState(agentsKeys.all)?.isInvalidated).toBe(true);
  });

  it('Cancel closes the sheet without a real recount', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: timeBaselines.recountButton }));
    await user.click(await screen.findByRole('button', { name: timeBaselines.recountCancel }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.count(REAL)).toBe(0);
  });

  it('a failed dry run shows a plain error', async () => {
    const { user } = setup(true, { status: 500, body: { error: 'Try again' } });
    await user.click(screen.getByRole('button', { name: timeBaselines.recountButton }));
    expect(await screen.findByText('Try again')).toHaveAttribute('role', 'alert');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders nothing when not allowed', () => {
    setup(false);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

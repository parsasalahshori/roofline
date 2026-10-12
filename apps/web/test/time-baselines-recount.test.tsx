import { cleanup, screen, waitFor } from '@testing-library/react';
import { hoursLabel } from '@roofline/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentsCommon, timeBaselines } from '../src/copy/agents.ts';
import { agentsKeys } from '../src/features/agents/api.ts';
import { TimeBaselines } from '../src/features/agents/TimeBaselines.tsx';
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

function setup(canRecount = true, blocked = false, dry: { status?: number; body?: unknown } = { body: { dryRun: true, ...RESULT } }) {
  api = stubApi({ [DRY]: () => dry, [REAL]: () => ({ body: { dryRun: false, ...RESULT } }) });
  return renderAt(<RecountSection canRecount={canRecount} blocked={blocked} />);
}

const before = `${timeBaselines.recountBefore} ${hoursLabel(1860)} ${agentsCommon.estimate}`;
const after = `${timeBaselines.recountAfter} ${hoursLabel(1620)} ${agentsCommon.estimate}`;

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
    const { user } = setup(true, false, { status: 500, body: { error: 'Try again' } });
    await user.click(screen.getByRole('button', { name: timeBaselines.recountButton }));
    expect(await screen.findByText('Try again')).toHaveAttribute('role', 'alert');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders nothing when not allowed', () => {
    setup(false);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('recount is disabled with a hint only when blocked', () => {
    setup(true, false);
    expect(screen.getByRole('button', { name: timeBaselines.recountButton })).toBeEnabled();
    expect(screen.queryByText(timeBaselines.recountUnsaved)).toBeNull();
    cleanup();
    setup(true, true);
    const button = screen.getByRole('button', { name: timeBaselines.recountButton });
    expect(button).toBeDisabled();
    const hint = screen.getByText(timeBaselines.recountUnsaved);
    expect(button.getAttribute('aria-describedby')).toBe(hint.id);
  });

  it('recount is disabled with a hint while there are unsaved edits', async () => {
    const rows = [{ key: 'text_sent', unit: 'text', basis: 'Each text', defaultMinutes: 2, minutes: 2, capMinutes: null, perCallLength: false }];
    const body = { rows, canEdit: true, hourlyRateCents: 2800 };
    api = stubApi({ 'GET /api/agents/time-baselines': () => ({ body }), 'PUT /api/agents/time-baselines': () => ({ body }) });
    const { user } = renderAt(<TimeBaselines />, '/settings/agents');
    const recount = await screen.findByRole('button', { name: timeBaselines.recountButton });
    expect(recount).toBeEnabled();
    const field = screen.getByRole('spinbutton');
    await user.clear(field);
    await user.type(field, '3');
    expect(recount).toBeDisabled();
    expect(screen.getByText(timeBaselines.recountUnsaved)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: timeBaselines.save }));
    await waitFor(() => expect(screen.getByRole('button', { name: timeBaselines.recountButton })).toBeEnabled());
    expect(screen.queryByText(timeBaselines.recountUnsaved)).toBeNull();
  });
});

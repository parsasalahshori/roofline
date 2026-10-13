import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, Providers } from '../src/app/providers.tsx';
import { liftSigned } from '../src/copy/liftSigned.ts';
import { SignedCard } from '../src/features/today/lift/SignedCard.tsx';
import { stubApi } from './helpers.tsx';

vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const KEY = 'GET /api/home/signed';

function weeks(totals: number[]) {
  return totals.map((totalCents, i) => ({ weekStart: `2026-${String(i + 1).padStart(2, '0')}-01`, totalCents }));
}

function show() {
  return render(
    <Providers client={createQueryClient()}>
      <SignedCard />
    </Providers>,
  );
}

describe('SignedCard', () => {
  it('shows the month total, goal, percent chip, twelve bars and the open pipeline', async () => {
    const api = stubApi({
      [KEY]: () => ({
        body: {
          monthTotalCents: 41_820_000,
          goalCents: 50_000_000,
          weekly: weeks([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20]),
          openPipelineCents: 60_010_000,
        },
      }),
    });
    const { container } = show();
    expect(await screen.findByText('$418,200')).toBeTruthy();
    expect(screen.getByRole('heading', { name: liftSigned.title })).toBeTruthy();
    expect(screen.getByText('84% of goal')).toBeTruthy();
    expect(screen.getByText('Goal $500,000')).toBeTruthy();
    expect(screen.getByText('$600,100')).toBeTruthy();
    expect(screen.getByText(liftSigned.axisStart)).toBeTruthy();
    expect(screen.getByText(liftSigned.axisEnd)).toBeTruthy();
    const bars = [...container.querySelectorAll('rect')];
    expect(bars).toHaveLength(12);
    expect(bars.filter((b) => b.getAttribute('data-current') === 'true')).toHaveLength(1);
    expect(bars[11]!.getAttribute('data-current')).toBe('true');
    expect(Math.max(...bars.map((b) => Number(b.getAttribute('height'))))).toBe(Number(bars[11]!.getAttribute('height')));
    expect(api.unexpected).toEqual([]);
  });

  it('leaves out the chip and the goal line when the company has no goal', async () => {
    stubApi({
      [KEY]: () => ({ body: { monthTotalCents: 123_400, goalCents: null, weekly: weeks(Array<number>(12).fill(100_000)), openPipelineCents: 0 } }),
    });
    show();
    expect(await screen.findByText('$1,234')).toBeTruthy();
    expect(screen.queryByText(/of goal/)).toBeNull();
    expect(screen.queryByText(/^Goal /)).toBeNull();
  });

  it('says so when nothing has been signed, and still shows the open pipeline', async () => {
    stubApi({
      [KEY]: () => ({ body: { monthTotalCents: 0, goalCents: null, weekly: weeks(Array<number>(12).fill(0)), openPipelineCents: 250_000 } }),
    });
    const { container } = show();
    expect(await screen.findByText(liftSigned.empty)).toBeTruthy();
    expect(container.querySelectorAll('rect')).toHaveLength(0);
    expect(screen.getByText('$2,500')).toBeTruthy();
  });

  it('shows a loading state before the answer arrives', async () => {
    stubApi({ [KEY]: () => ({ body: { monthTotalCents: 0, goalCents: null, weekly: [], openPipelineCents: 0 } }) });
    show();
    expect(screen.getByRole('status', { name: liftSigned.loading })).toBeTruthy();
    expect(await screen.findByText(liftSigned.empty)).toBeTruthy();
  });

  it('shows a message when the numbers cannot be loaded', async () => {
    stubApi({ [KEY]: () => ({ status: 403, body: { error: 'No.' } }) });
    show();
    expect(await screen.findByText(liftSigned.loadFailed)).toBeTruthy();
  });
});

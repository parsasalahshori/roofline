import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { liftMeasureSteps, liftProposal } from '../src/copy/liftMeasure.ts';
import { RoofQuoteBar } from '../src/features/measure/lift/RoofQuoteBar.tsx';
import { wholeDollars } from '../src/features/measure/lift/proposalLines.ts';
import type { MeasurementPreview, PreviewOption } from '../src/features/measure/types.ts';

afterEach(cleanup);

function option(tier: 'good' | 'better' | 'best', totalCents: number, over: Partial<PreviewOption> = {}): PreviewOption {
  return {
    id: `o-${tier}`,
    tier,
    name: tier,
    enabled: true,
    totalCents,
    wastePercent: 12,
    calculation: { roofSquares: 27.2 },
    ...over,
  } as unknown as PreviewOption;
}

const preview = (options: PreviewOption[]) => ({ options }) as unknown as MeasurementPreview;

describe('RoofQuoteBar: a phone\'s pinned way from the roof to the proposal', () => {
  it('names the recommended tier, the squares measured and its total, with a Proposal button', () => {
    const onOpen = vi.fn();
    render(<RoofQuoteBar preview={preview([option('good', 1_452_500), option('better', 1_555_300), option('best', 1_841_500)])} onOpen={onOpen} />);
    expect(screen.getByText(liftProposal.quoteBar.label(liftProposal.tier.better, 27.2))).toBeInTheDocument();
    expect(screen.getByText(wholeDollars(1_555_300))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: liftMeasureSteps.proposal }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('falls back to the first tier that is on when Better is left out', () => {
    render(<RoofQuoteBar preview={preview([option('good', 1_452_500), option('better', 1_555_300, { enabled: false }), option('best', 1_841_500)])} onOpen={() => undefined} />);
    expect(screen.getByText(liftProposal.quoteBar.label(liftProposal.tier.good, 27.2))).toBeInTheDocument();
    expect(screen.getByText(wholeDollars(1_452_500))).toBeInTheDocument();
  });

  it('draws nothing while there is no price to show', () => {
    const { container, rerender } = render(<RoofQuoteBar preview={undefined} onOpen={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<RoofQuoteBar preview={preview([])} onOpen={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

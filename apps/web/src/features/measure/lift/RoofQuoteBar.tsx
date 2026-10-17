import { Button, Icon } from '@roofline/ui';
import type { Tier } from '@roofline/shared';
import { liftMeasureSteps, liftProposal } from '../../../copy/liftMeasure.ts';
import type { MeasurementPreview } from '../types.ts';
import { squaresFor, wholeDollars } from './proposalLines.ts';
import styles from '../MeasureWindow.module.css';

const RECOMMENDED: Tier = 'better';

/**
 * A phone's pinned bar on the roof step: the recommended tier, the squares measured and its total, with the way to the
 * proposal (the third step). Where the proposal is a column beside the roof, the css leaves the bar out.
 */
export function RoofQuoteBar({ preview, onOpen }: { preview: MeasurementPreview | undefined; onOpen: () => void }) {
  const options = (preview?.options ?? []).filter((o) => o.enabled);
  const picked = options.find((o) => o.tier === RECOMMENDED) ?? options[0];
  if (picked === undefined) return null;
  return (
    <div className={styles.quoteBar} data-quote-bar="">
      <div className={styles.quoteBarText}>
        <span className={styles.quoteBarLabel}>{liftProposal.quoteBar.label(liftProposal.tier[picked.tier], squaresFor(picked).measured)}</span>
        <span className={styles.quoteBarTotal}>{wholeDollars(picked.totalCents)}</span>
      </div>
      <Button onClick={onOpen}>
        {liftMeasureSteps.proposal}
        <Icon name="arrow" size={18} />
      </Button>
    </div>
  );
}

import { Button, Card } from '@roofline/ui';
import { useId } from 'react';
import { common } from '../../copy/common.ts';
import { legal } from '../../copy/legal.ts';
import { mapCopy } from '../../copy/map.ts';
import styles from './PinCard.module.css';

export type RoofCardProps = {
  /** Starts the estimate; the card shows the button busy until it settles. */
  onEstimate: () => void;
  busy: boolean;
  onClose: () => void;
  /** The outline is Google Solar's (no footprint here): the card says so. */
  fromSolar?: boolean;
};

/** The card a click on a roof opens: "This roof", a hint, and Estimate this roof. MapView places it. */
export function RoofCard({ onEstimate, busy, onClose, fromSolar = false }: RoofCardProps) {
  const titleId = useId();
  return (
    <Card as="section" aria-labelledby={titleId} className={styles.card} data-kind="roof">
      <h2 id={titleId} className={styles.name}>
        {mapCopy.roofTitle}
      </h2>
      <p className={styles.address}>{mapCopy.roofHint}</p>
      {fromSolar ? <p className={styles.address}>{legal.solarOutlineAttribution}</p> : null}
      <div className={styles.actions}>
        <Button onClick={onEstimate} disabled={busy} aria-busy={busy}>
          {mapCopy.estimateRoof}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {common.close}
        </Button>
      </div>
    </Card>
  );
}

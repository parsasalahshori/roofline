import { Button, Card } from '@roofline/ui';
import { useId } from 'react';
import { common } from '../../copy/common.ts';
import { mapCopy } from '../../copy/map.ts';
import styles from './PinCard.module.css';
import type { PickedPin, PinTarget } from './types.ts';

export type PinCardProps = {
  pin: PickedPin;
  /** Called with the pin's `{ kind, id }` when Open is pressed. */
  onOpen: (target: PinTarget) => void;
  onClose: () => void;
};

/** The card a picked pin opens: its name, address and stage (jobs only), with Open and Close. MapView places it. */
export function PinCard({ pin, onOpen, onClose }: PinCardProps) {
  const titleId = useId();
  return (
    <Card as="section" aria-labelledby={titleId} className={styles.card} data-kind={pin.kind}>
      <h2 id={titleId} className={styles.name}>
        {pin.name}
      </h2>
      <p className={styles.address}>{pin.addressLine}</p>
      {pin.stageLabel !== null ? (
        <p className={styles.stage} data-stage={pin.stage ?? undefined}>
          {pin.stageLabel}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button onClick={() => onOpen({ kind: pin.kind, id: pin.id })}>{mapCopy.open}</Button>
        <Button variant="ghost" onClick={onClose}>
          {common.close}
        </Button>
      </div>
    </Card>
  );
}

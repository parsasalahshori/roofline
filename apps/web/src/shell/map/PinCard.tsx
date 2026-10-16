import { Button, Card, IconButton, Icon } from '@roofline/ui';
import { useId } from 'react';
import { common } from '../../copy/common.ts';
import { mapCopy } from '../../copy/map.ts';
import { directionsUrl, NEW_TAB } from './directions.ts';
import styles from './PinCard.module.css';
import type { PickedPin, PinTarget } from './types.ts';

export type PinCardProps = {
  pin: PickedPin;
  /** Called with the pin's `{ kind, id }` when Open job (or Open customer) is pressed. */
  onOpen: (target: PinTarget) => void;
  onClose: () => void;
};

/**
 * The card a picked pin opens: its name, its stage (jobs only), its address, then Open job and Directions. MapView
 * places it over the map. A customer with no open job has no stage and opens the customer instead.
 */
export function PinCard({ pin, onOpen, onClose }: PinCardProps) {
  const titleId = useId();
  return (
    <Card as="section" aria-labelledby={titleId} className={styles.card} data-kind={pin.kind}>
      <div className={styles.head}>
        <h2 id={titleId} className={styles.name}>
          {pin.name}
        </h2>
        {pin.stageLabel !== null ? (
          <span className={styles.stage} data-stage={pin.stage ?? undefined}>
            {pin.stageLabel}
          </span>
        ) : null}
        <IconButton label={common.close} className={styles.close} onClick={onClose} icon={<Icon name="x" size={16} />} />
      </div>
      {pin.addressLine !== '' ? <p className={styles.address}>{pin.addressLine}</p> : null}
      <div className={styles.actions}>
        <Button size="sm" variant="default" onClick={() => onOpen({ kind: pin.kind, id: pin.id })}>
          {pin.kind === 'job' ? mapCopy.openJob : mapCopy.openCustomer}
        </Button>
        {pin.addressLine !== '' ? (
          <Button size="sm" variant="ghost" href={directionsUrl(pin.addressLine)} {...NEW_TAB}>
            {mapCopy.directions}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

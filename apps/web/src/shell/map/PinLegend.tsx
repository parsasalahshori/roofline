import { mapCopy } from '../../copy/map.ts';
import styles from './MapLegend.module.css';

export type PinLegendProps = { visible: boolean };

/** The pin colours and what each one is: the four open stages of a job, and a customer with no open job. */
const PINS = [
  ['lead', 'st-lead'],
  ['inspection', 'st-insp'],
  ['proposal', 'st-prop'],
  ['won', 'st-won'],
  ['customer', 'st-inst'],
] as const;

/** The key to the pins, beside the hail key. Hidden when the Jobs layer is off. */
export function PinLegend({ visible }: PinLegendProps) {
  if (!visible) return null;
  return (
    <section className={styles.group} aria-label={mapCopy.pinLegend} data-testid="pin-legend">
      <ul className={styles.list}>
        {PINS.map(([key, token]) => (
          <li key={key} className={styles.item}>
            <span className={styles.dot} data-pin={key} style={{ background: `var(--${token})` }} />
            <span>{mapCopy.pinNames[key]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

import { HailLegend } from './HailLegend.tsx';
import styles from './MapLegend.module.css';
import { PinLegend } from './PinLegend.tsx';

export type MapLegendProps = {
  /** The hail key: the layer is on and a swath is drawn. */
  hail: boolean;
  /** The pin key: the Jobs layer is on. */
  pins: boolean;
  /** A card is open over the map: on a phone the key steps aside for it. */
  suppressed?: boolean;
};

/** The legend row over the map's bottom left: the hail sizes, a hairline, then the pin colours. Nothing while both are hidden. */
export function MapLegend({ hail, pins, suppressed = false }: MapLegendProps) {
  if (!hail && !pins) return null;
  return (
    <div className={styles.legend} data-testid="map-legend" data-suppressed={suppressed ? 'true' : undefined}>
      <HailLegend visible={hail} />
      {hail && pins ? <span className={styles.divider} aria-hidden="true" /> : null}
      <PinLegend visible={pins} />
    </div>
  );
}

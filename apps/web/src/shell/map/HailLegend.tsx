import { mapCopy } from '../../copy/map.ts';
import styles from './MapLegend.module.css';

export type HailLegendProps = { visible: boolean };

const LEVELS = [1, 2, 3, 4, 5] as const;

/** The key to the hail colours: one swatch and one everyday name per level, in the map's legend row. Hidden while there is nothing to explain. */
export function HailLegend({ visible }: HailLegendProps) {
  if (!visible) return null;
  return (
    <section className={`${styles.group} ${styles.hail}`} aria-label={mapCopy.hailLegend} data-testid="hail-legend">
      <p className="visually-hidden">{mapCopy.hailLegendTitle}</p>
      <ul className={styles.list}>
        {LEVELS.map((level) => (
          <li key={level} className={styles.item} data-ramp={level === 1 ? 'first' : level === LEVELS.length ? 'last' : 'middle'} title={mapCopy.hailSizeLevels[level - 1]}>
            <span className={styles.swatch} data-level={level} style={{ background: `var(--hail-${level})` }} />
            <span className={styles.name}>{mapCopy.hailSizeNames[level - 1]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

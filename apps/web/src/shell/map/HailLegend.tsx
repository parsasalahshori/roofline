import { mapCopy } from '../../copy/map.ts';
import styles from './HailLegend.module.css';

export type HailLegendProps = { visible: boolean };

const LEVELS = [1, 2, 3, 4, 5] as const;

/** The key to the hail colours: a compact row of chips, one swatch and one everyday name per level. Hidden while there is nothing to explain. */
export function HailLegend({ visible }: HailLegendProps) {
  if (!visible) return null;
  return (
    <section className={styles.legend} aria-label={mapCopy.hailLegend} data-testid="hail-legend">
      <p className={styles.title}>{mapCopy.hailLegendTitle}</p>
      <ul className={styles.list}>
        {LEVELS.map((level) => (
          <li key={level} className={styles.chip} title={mapCopy.hailSizeLevels[level - 1]}>
            <span className={styles.swatch} data-level={level} style={{ background: `var(--hail-${level})` }} />
            <span>{mapCopy.hailSizeNames[level - 1]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

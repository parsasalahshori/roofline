import type { Brand } from './useBrand.ts';
import styles from './BrandMark.module.css';

/**
 * The company's square mark: its logo when it has one, otherwise its initials on an ink tile with a brand-coloured
 * foot. Decorative: the company's name is always written beside it.
 */
export function BrandMark({ brand, size = 34 }: { brand: Brand; size?: 28 | 34 }) {
  return (
    <span className={styles.mark} data-size={size} aria-hidden="true">
      {brand.logoUrl ? <img src={brand.logoUrl} alt="" className={styles.logo} /> : <span className={styles.initials}>{brand.initials}</span>}
    </span>
  );
}

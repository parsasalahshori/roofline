import type { DesignIssue, ProductCatalog, Tier, WindowDesign } from '@roofline/shared';
import { Icon } from '@roofline/ui';
import { backofficeDesigner as copy } from '../../../copy/backofficeDesigner.ts';
import { frameColorHex } from '../drawing/colors.ts';
import { formatInches } from '../drawing/inches.ts';
import { UnitDrawing } from '../drawing/UnitDrawing.tsx';
import { chosenOption, dollars, productOf, unitPriceCents } from './pricing.ts';
import styles from './UnitCard.module.css';

type Props = { design: WindowDesign; catalog: ProductCatalog; tier: Tier; issues: DesignIssue[]; selected: boolean; onOpen: () => void };

/** One unit in the grid: its drawing, room, size, product, price for the chosen tier and any problems. */
export function UnitCard({ design, catalog, tier, issues, selected, onOpen }: Props) {
  const product = productOf(catalog, design.productId);
  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.length - errors;
  const each = unitPriceCents(catalog, design, tier);
  const color = chosenOption(catalog, design, 'exterior-color')?.value;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={copy.openUnit(design.label)}
      className={styles.card}
      data-selected={selected ? 'true' : undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className={styles.drawing}>
        <UnitDrawing design={design} frameColor={frameColorHex(color)} />
      </div>
      <div className={styles.text}>
        <h3 className={styles.room}>{design.label}</h3>
        <p className={styles.size}>
          {copy.sizeText(formatInches(design.widthIn), formatInches(design.heightIn))}
          {design.quantity > 1 ? <span className={styles.qty}>{copy.times(design.quantity)}</span> : null}
        </p>
        <p className={styles.product}>{product?.name ?? copy.noProduct}</p>
      </div>
      <div className={styles.foot}>
        <span className={styles.price}>{dollars(each * design.quantity)}</span>
        <span className={styles.badges}>
          {errors > 0 ? (
            <span className={styles.badge} data-tone="error" title={issues.find((i) => i.level === 'error')?.message}>
              <Icon name="alert" size={16} />
              {copy.issueCount(errors, 'error')}
            </span>
          ) : null}
          {warnings > 0 ? (
            <span className={styles.badge} data-tone="warning" title={issues.find((i) => i.level === 'warning')?.message}>
              <Icon name="alert" size={16} />
              {copy.issueCount(warnings, 'warning')}
            </span>
          ) : null}
          {design.sizeSource.kind === 'measured' ? (
            <span className={styles.badge} data-tone="info">
              <Icon name="ruler" size={16} />
              {copy.measuredBadge}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

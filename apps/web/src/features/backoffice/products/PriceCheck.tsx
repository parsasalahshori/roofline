import { OPTION_GROUPS, TIERS } from '@roofline/shared';
import { Banner, Select } from '@roofline/ui';
import { useState } from 'react';
import { backoffice as copy } from '../../../copy/backoffice.ts';
import shared from '../backoffice.module.css';
import { formatExact } from '../format.ts';
import type { Draft } from './draft.ts';
import { NumField } from './fields.tsx';
import { optionsFor, priceCheck } from './pricing.ts';
import styles from './products.module.css';

const t = copy.products;

/** The calculator: pick a product, a size and options, and see the three prices. It reads the price book being edited. */
export function PriceCheck({ draft }: { draft: Draft }) {
  const live = draft.catalog.products.filter((p) => !p.archived);
  const [productId, setProductId] = useState('');
  const [width, setWidth] = useState(36);
  const [height, setHeight] = useState(60);
  const [sections, setSections] = useState(1);
  const [lites, setLites] = useState(0);
  const [picked, setPicked] = useState<Record<string, string>>({});

  if (live.length === 0) return <p className="bo-foot">{t.checkNoProducts}</p>;
  const product = live.find((p) => p.id === productId) ?? live[0]!;
  const choices = optionsFor(draft.catalog, product.id);
  // The option picked for a group: what was chosen, else the group's default, else none
  const selected = OPTION_GROUPS.map((group) => {
    const here = choices.filter((o) => o.group === group);
    return picked[group] ?? here.find((o) => o.isDefault)?.id ?? '';
  }).filter((id) => id !== '');
  const result = priceCheck(draft.catalog, {
    productId: product.id,
    widthIn: width,
    heightIn: height,
    sections,
    lites,
    optionIds: selected,
  });
  const ready = [width, height, sections, lites].every(Number.isFinite);

  return (
    <div className={shared.stack}>
      <p className="bo-foot">{t.checkHelp}</p>
      <div className={shared.card}>
        <div className={shared.grid}>
          <Select
            label={t.checkProduct}
            value={product.id}
            onChange={setProductId}
            options={live.map((p) => ({ value: p.id, label: p.name }))}
          />
          <NumField label={t.checkSections} value={sections} onChange={setSections} />
          <NumField label={t.checkWidth} value={width} onChange={setWidth} />
          <NumField label={t.checkHeight} value={height} onChange={setHeight} />
          <NumField label={t.checkLites} value={lites} onChange={setLites} />
        </div>
      </div>

      {choices.length > 0 ? (
        <div className={shared.card}>
          <div className={shared.grid}>
            {OPTION_GROUPS.filter((group) => choices.some((o) => o.group === group)).map((group) => {
              const here = choices.filter((o) => o.group === group);
              const value = picked[group] ?? here.find((o) => o.isDefault)?.id ?? '';
              return (
                <Select
                  key={group}
                  label={t.optionGroups[group]}
                  value={value}
                  onChange={(next) => setPicked((previous) => ({ ...previous, [group]: next }))}
                  options={[{ value: '', label: t.checkNone }, ...here.map((o) => ({ value: o.id, label: o.label }))]}
                />
              );
            })}
          </div>
        </div>
      ) : null}

      {result && ready ? (
        <>
          {result.pastTable ? <Banner tone="warning">{t.checkOver}</Banner> : null}
          {result.outsideLimits ? <Banner tone="warning">{t.checkOutside}</Banner> : null}
          <h3 className="bo-grouphead">{t.checkResult}</h3>
          <ul className="bo-group" aria-label={t.checkResult}>
            {TIERS.map((tier) => {
              const line = result.tiers[tier];
              return (
                <li key={tier} className={styles.checkRow}>
                  <div className="bo-row">
                    <span className="bo-row-main">
                      <b>{draft.catalog.tiers[tier].label}</b>
                      <small className="bo-foot">
                        {t.checkBreakdown(formatExact(line.baseCents), formatExact(line.sectionsCents), formatExact(line.optionsCents), formatExact(line.markupCents))}
                      </small>
                    </span>
                    <strong className={styles.total} data-testid={'check-' + tier}>
                      {formatExact(line.totalCents)}
                    </strong>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}

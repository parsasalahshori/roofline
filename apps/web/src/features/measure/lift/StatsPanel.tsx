import { Banner, Skeleton } from '@roofline/ui';
import type { ReactNode } from 'react';
import { liftMeasure } from '../../../copy/liftMeasure.ts';
import { measure } from '../../../copy/measure.ts';
import { useMeasurement } from '../api.ts';
import type { MeasurementView } from '../types.ts';
import styles from './StatsPanel.module.css';

const SQUARES_DECIMALS = 1;

/**
 * The grid cells the measurement really has, in order. A length of zero means the estimate had nothing
 * to measure there (instantEstimate turns a missing value into 0), so it is left out rather than shown.
 */
export function statCells(m: MeasurementView): { key: string; label: string; value: string }[] {
  const cells: { key: string; label: string; value: string }[] = [
    { key: 'pitch', label: liftMeasure.pitch, value: liftMeasure.pitchValue(m.estimate.pitchX12) },
  ];
  if (m.facets !== null) cells.push({ key: 'facets', label: liftMeasure.facets, value: String(m.facets) });
  if (m.estimate.ridgeFt > 0) cells.push({ key: 'ridges', label: liftMeasure.ridges, value: liftMeasure.feet(m.estimate.ridgeFt) });
  if (m.estimate.valleyFt > 0) cells.push({ key: 'valleys', label: liftMeasure.valleys, value: liftMeasure.feet(m.estimate.valleyFt) });
  if (m.estimate.edgeFt > 0) cells.push({ key: 'edges', label: liftMeasure.edges, value: liftMeasure.feet(m.estimate.edgeFt) });
  return cells;
}

export function StatsPanel({ measurementId, actions }: { measurementId: string; actions?: ReactNode }) {
  const query = useMeasurement(measurementId);
  const m = query.data;

  return (
    <section className={styles.panel} aria-label={liftMeasure.statsLabel} aria-busy={query.isPending}>
      {m === undefined ? (
        query.isError ? (
          <div role="alert">
            <Banner tone="danger">{liftMeasure.loadFailed}</Banner>
          </div>
        ) : (
          <>
            <Skeleton width="60%" height="1rem" />
            <Skeleton width="40%" height="2rem" />
            <Skeleton lines={2} height="1rem" />
          </>
        )
      ) : (
        <>
          <div className={styles.head}>
            <h2 className={styles.title}>
              {m.facets !== null ? liftMeasure.statsTracing(m.facets) : liftMeasure.statsTracingPlain}
            </h2>
            <span className={styles.kind}>{m.kind === 'exact' ? measure.exactLabel : measure.estimateLabel}</span>
          </div>
          <div className={styles.big}>
            <span className={styles.squares}>
              {m.estimate.squares.toLocaleString(undefined, { maximumFractionDigits: SQUARES_DECIMALS })}
            </span>
            <span className={styles.unit}>{liftMeasure.squaresUnit}</span>
            <span className={styles.sqft}>{liftMeasure.roofArea(m.estimate.surfaceSqFt)}</span>
          </div>
          <dl className={styles.grid}>
            {statCells(m).map((cell) => (
              <div key={cell.key} className={styles.cell} data-stat={cell.key}>
                <dt>{cell.label}</dt>
                <dd>{cell.value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {actions !== undefined ? <div className={styles.actions}>{actions}</div> : null}
    </section>
  );
}

import { Banner, Skeleton } from '@roofline/ui';
import { useContext, type ReactNode } from 'react';
import { liftMeasure } from '../../../copy/liftMeasure.ts';
import { measure } from '../../../copy/measure.ts';
import { useMeasurement } from '../api.ts';
import type { MeasurementView } from '../types.ts';
import styles from './StatsPanel.module.css';
import { MeasureSlotsContext } from './slots.ts';

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
  const { panels, estimate: live } = useContext(MeasureSlotsContext);
  // The editor's numbers run ahead of what is saved, so a dragged corner shows at once
  const m = query.data !== undefined && live !== null ? { ...query.data, estimate: live } : query.data;

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
            <span className={styles.icon} aria-hidden="true">
              <svg viewBox="0 0 16 16" width="12" height="12" focusable="false">
                <path d="M3 10.5 8 5.5l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <h2 className={styles.title}>
              {m.facets !== null ? liftMeasure.statsTracing(m.facets) : liftMeasure.statsTracingPlain}
            </h2>
            <span className={styles.kind} data-kind={m.kind}>
              {m.kind === 'exact' ? measure.exactLabel : measure.estimateLabel}
            </span>
          </div>
          <div className={styles.body}>
            <div className={styles.big}>
              <span className={styles.label}>{liftMeasure.totalArea}</span>
              <span className={styles.squaresRow}>
                <span className={styles.squares}>
                  {m.estimate.squares.toLocaleString(undefined, { maximumFractionDigits: SQUARES_DECIMALS })}
                </span>
                <span className={styles.unit}>{liftMeasure.squaresUnit}</span>
              </span>
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
          </div>
        </>
      )}
      {actions !== undefined ? <div className={styles.actions}>{actions}</div> : null}
      {panels !== null ? <div className={styles.adjust}>{panels}</div> : null}
    </section>
  );
}

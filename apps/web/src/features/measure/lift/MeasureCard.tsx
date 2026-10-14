import { Button } from '@roofline/ui';
import type { InstantEstimate } from '@roofline/shared';
import { useId, type ReactNode } from 'react';
import { legal } from '../../../copy/legal.ts';
import { liftMeasure } from '../../../copy/liftMeasure.ts';
import { measure } from '../../../copy/measure.ts';
import type { MeasurementView } from '../types.ts';
import { AiMark } from './AiMark.tsx';
import { LINE_COLORS, type RoofLineKind, type RoofModel } from './roofModel.ts';
import { shownShare, stageAt, type ScanSession } from './scan.ts';
import styles from './MeasureCard.module.css';

type Cell = { key: string; label: string; value: string; line?: RoofLineKind; muted?: boolean };

/** What the card reports: the measured roof's totals, or (no facets) the outline's estimate. */
export type CardNumbers = {
  squares: number;
  slopedSqFt: number;
  pitch: string;
  facets: number | null;
  wastePct: number | null;
  lines: { kind: RoofLineKind; ft: number }[] | null;
  ridgeFt: number;
  valleyFt: number;
  edgeFt: number;
};

export function cardNumbers(m: MeasurementView, estimate: InstantEstimate, model: RoofModel | null, wastePct: number | null): CardNumbers {
  if (model !== null) {
    const t = model.totals;
    return {
      squares: t.squares,
      slopedSqFt: t.slopedSqFt,
      pitch: model.pitch,
      facets: t.facetCount,
      wastePct: t.wastePct,
      lines: [
        { kind: 'ridge', ft: t.ridgeFt },
        { kind: 'hip', ft: t.hipFt },
        { kind: 'valley', ft: t.valleyFt },
        { kind: 'eave', ft: t.eaveFt },
        { kind: 'rake', ft: t.rakeFt },
      ],
      ridgeFt: t.ridgeFt,
      valleyFt: t.valleyFt,
      edgeFt: t.eaveFt + t.rakeFt,
    };
  }
  return {
    squares: estimate.squares,
    slopedSqFt: estimate.surfaceSqFt,
    pitch: liftMeasure.pitchValue(estimate.pitchX12),
    facets: m.facets,
    wastePct,
    lines: null,
    ridgeFt: estimate.ridgeFt,
    valleyFt: estimate.valleyFt,
    edgeFt: estimate.edgeFt,
  };
}

const LINE_LABEL: Record<RoofLineKind, string> = {
  ridge: liftMeasure.ridges,
  hip: liftMeasure.hips,
  valley: liftMeasure.valleys,
  eave: liftMeasure.eaves,
  rake: liftMeasure.rakes,
};

/** The grid under the big number. `share` (0 to 1) is how much of each number shows while the scan plays. */
export function cardCells(n: CardNumbers, share: number, pitchKnown: boolean): Cell[] {
  const part = (v: number) => v * share;
  const cells: Cell[] = [
    { key: 'pitch', label: liftMeasure.pitch, value: pitchKnown ? n.pitch : liftMeasure.pitchReading },
    { key: 'facets', label: liftMeasure.facets, value: n.facets === null ? '—' : String(Math.round(part(n.facets))) },
    { key: 'waste', label: liftMeasure.waste, value: n.wastePct === null ? '—' : liftMeasure.percent(part(n.wastePct)) },
  ];
  if (n.lines !== null) {
    for (const line of n.lines) {
      cells.push({ key: `${line.kind}s`, label: LINE_LABEL[line.kind], value: liftMeasure.feet(part(line.ft)), line: line.kind, muted: line.ft <= 0 });
    }
  } else {
    cells.push({ key: 'ridges', label: liftMeasure.ridges, value: liftMeasure.feet(part(n.ridgeFt)), line: 'ridge', muted: n.ridgeFt <= 0 });
    cells.push({ key: 'valleys', label: liftMeasure.valleys, value: liftMeasure.feet(part(n.valleyFt)), line: 'valley', muted: n.valleyFt <= 0 });
    cells.push({ key: 'edges', label: liftMeasure.edges, value: liftMeasure.feet(part(n.edgeFt)), muted: n.edgeFt <= 0 });
  }
  return cells;
}

function RotateIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

/**
 * The card over the bottom left of the photo: what the scan is doing and its seconds while it plays, then
 * "Measured by Estimator in N seconds" with Re-measure, the total in squares and every measured line.
 * Adjust opens the controls that change the estimate (and the outline's handles) below the numbers.
 */
export function MeasureCard({
  m,
  numbers,
  scan,
  outlineOnly,
  locked = false,
  editing,
  onEdit,
  panels,
}: {
  m: MeasurementView;
  numbers: CardNumbers;
  scan: ScanSession;
  outlineOnly: boolean;
  /** Sent (or refused as sent): the card says the roof can no longer change. */
  locked?: boolean;
  editing: boolean;
  onEdit: (next: boolean) => void;
  panels: ReactNode;
}) {
  const adjustId = useId();
  const scanning = scan.phase === 'scanning';
  const share = scanning ? shownShare(scan.progress) : 1;
  const stage = stageAt(scan.progress);
  const pitchKnown = !scanning || scan.progress >= 0.55;
  const title = scanning
    ? stage === 'tracing'
      ? liftMeasure.stage.tracing(scan.facets)
      : liftMeasure.stage[stage]
    : m.kind === 'exact'
      ? measure.exactLabel
      : liftMeasure.measuredBy;

  return (
    <section className={styles.card} aria-label={liftMeasure.statsLabel} data-phase={scan.phase}>
      <div className={styles.head}>
        <AiMark labelled />
        <h2 className={styles.title} {...(scanning ? { role: 'status' } : {})}>
          {title}
        </h2>
        {scanning ? (
          <span className={styles.timer}>{liftMeasure.seconds(scan.elapsedMs / 1000)}</span>
        ) : (
          <>
            {m.kind !== 'exact' && scan.totalMs > 0 && !m.locked ? <span className={styles.seconds}>{liftMeasure.measuredIn(scan.totalMs / 1000)}</span> : null}
            <span className={styles.spacer} />
            {!m.locked && m.kind !== 'exact' ? (
              <Button variant="ghost" className={styles.headButton} onClick={scan.restart}>
                <RotateIcon />
                {liftMeasure.remeasure}
              </Button>
            ) : null}
          </>
        )}
      </div>
      <div className={styles.body}>
        <div className={styles.big}>
          <span className={styles.label}>{liftMeasure.totalArea}</span>
          <span className={styles.squaresRow}>
            <span className={styles.squares}>{(numbers.squares * share).toFixed(1)}</span>
            <span className={styles.unit}>{liftMeasure.squaresUnit}</span>
          </span>
          <span className={styles.sqft}>{liftMeasure.sloped(numbers.slopedSqFt * share)}</span>
        </div>
        <dl className={styles.grid} data-cells={numbers.lines !== null ? 'roof' : 'outline'}>
          {cardCells(numbers, share, pitchKnown).map((cell) => (
            <div key={cell.key} className={styles.cell} data-stat={cell.key}>
              <dt>
                {cell.line !== undefined ? <span className={styles.dash} style={{ background: LINE_COLORS[cell.line] }} aria-hidden="true" /> : null}
                <span className={styles.cellLabel}>{cell.label}</span>
              </dt>
              <dd data-muted={cell.muted === true ? 'true' : undefined}>{cell.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {locked && !scanning ? (
        <p className={styles.note} data-tone="locked">
          {measure.locked}
        </p>
      ) : null}
      {outlineOnly && !scanning ? <p className={styles.note}>{liftMeasure.outlineOnly}</p> : null}
      {m.pitchSource === 'solar' && m.kind !== 'exact' && !scanning ? (
        <p className={styles.note} data-source="solar">
          {legal.solarPitchAttribution}
        </p>
      ) : null}
      {!scanning ? (
        <div className={styles.foot}>
          {panels !== null ? (
            <Button
              variant="ghost"
              className={styles.footButton}
              aria-expanded={editing}
              aria-controls={adjustId}
              onClick={() => onEdit(!editing)}
            >
              {liftMeasure.adjust}
              <svg className={styles.chevron} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
                <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Button>
          ) : null}
          <span className={styles.kind} data-kind={m.kind}>
            {m.kind === 'exact' ? measure.exactLabel : measure.estimateLabel}
          </span>
        </div>
      ) : null}
      {editing && panels !== null ? (
        <div id={adjustId} className={styles.adjust}>
          {panels}
        </div>
      ) : null}
    </section>
  );
}

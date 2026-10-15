import { Button } from '@roofline/ui';
import { quotedTotals, type InstantEstimate } from '@roofline/shared';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { legal } from '../../../copy/legal.ts';
import { liftMeasure } from '../../../copy/liftMeasure.ts';
import { measure } from '../../../copy/measure.ts';
import type { MeasurementView } from '../types.ts';
import { edgeCueText, hiddenEdges } from './edgeCue.ts';
import { LINE_COLORS, type RoofLineKind, type RoofModel } from './roofModel.ts';
import { ScanCardHead } from './ScanCardHead.tsx';
import { shownShare, stageAt, type ScanSession } from './scan.ts';
import type { QuoteSession } from './slots.ts';
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

/** The card's numbers: the quoted sections' totals (the whole roof's when every section is in the quote). */
export function cardNumbers(m: MeasurementView, estimate: InstantEstimate, model: RoofModel | null, wastePct: number | null): CardNumbers {
  if (model !== null) {
    const t = quotedTotals(model);
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
        // A roof measured in 3D: its flashing and flat edges, when it has any.
        ...((t.flashingFt ?? 0) > 0 ? [{ kind: 'flashing' as const, ft: t.flashingFt ?? 0 }] : []),
        ...((t.stepFt ?? 0) > 0 ? [{ kind: 'step-flashing' as const, ft: t.stepFt ?? 0 }] : []),
        ...((t.flatEdgeFt ?? 0) > 0 ? [{ kind: 'flat-edge' as const, ft: t.flatEdgeFt ?? 0 }] : []),
      ],
      ridgeFt: t.ridgeFt,
      valleyFt: t.valleyFt,
      edgeFt: t.eaveFt + t.rakeFt + (t.flatEdgeFt ?? 0),
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
  flashing: liftMeasure.flashing,
  'step-flashing': liftMeasure.stepFlashing,
  'flat-edge': liftMeasure.flatEdges,
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

/** "3 of 7 sections in the quote · Include all", or how to leave one out, under the numbers of a roof with sections. */
function Sections({ model, quote, locked, editing }: { model: RoofModel; quote: QuoteSession; locked: boolean; editing: boolean }) {
  const total = model.facets.length;
  const out = quote.excluded.length;
  if (out === 0) {
    // Adjust open: the room is the controls'; the line comes back with the labels when it closes
    if (locked || total < 2 || editing) return null;
    return (
      <p className={styles.sections} data-sections="all">
        <span>{liftMeasure.allSectionsInQuote(total)}</span>
        <span className={styles.sectionsHint}>{liftMeasure.sectionsHint}</span>
      </p>
    );
  }
  return (
    <p className={styles.sections} data-sections="some" role="status">
      <strong>{liftMeasure.sectionsInQuote(total - out, total)}</strong>
      {!locked ? (
        <Button variant="ghost" className={styles.includeAll} onClick={quote.includeAll}>
          {liftMeasure.includeAll}
        </Button>
      ) : null}
    </p>
  );
}

/**
 * The card over the bottom left of the photo: what the scan is doing and its seconds while it plays, then
 * "Measured by Estimator in N seconds" with Re-measure, the total in squares and every measured line.
 * Adjust opens the controls that change the estimate (and the outline's handles). The card never covers the roof:
 * open, it is at most 45% of the photo's height and scrolls inside, its numbers fold to one line, and the Adjust
 * toggle keeps its place at the bottom (the card grows upwards), with Done at the end of the controls.
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
  model = null,
  quote = null,
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
  /** The measured roof, for the sections line. */
  model?: RoofModel | null;
  quote?: QuoteSession | null;
}) {
  const adjustId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement | HTMLAnchorElement>(null);
  const scanning = scan.phase === 'scanning';
  const edgeCue = edgeCueText(hiddenEdges(m.roof3d, m.outline?.[0]), m.roof3d);
  const share = scanning ? shownShare(scan.progress) : 1;
  const stage = stageAt(scan.progress);
  const pitchKnown = !scanning || scan.progress >= 0.55;
  const open = editing && panels !== null && !scanning;
  const title = scanning
    ? stage === 'tracing'
      ? liftMeasure.stage.tracing(scan.facets)
      : liftMeasure.stage[stage]
    : m.kind === 'exact'
      ? measure.exactLabel
      : liftMeasure.measuredBy;

  // Opening Adjust shows the controls from their top
  useEffect(() => {
    if (open) scrollRef.current?.scrollTo?.({ top: 0 });
  }, [open]);

  const done = () => {
    onEdit(false);
    // Done sits at the end of the controls, which go away: focus goes back to the Adjust toggle
    queueMicrotask(() => toggleRef.current?.focus());
  };

  return (
    <section className={styles.card} aria-label={liftMeasure.statsLabel} data-measure-card="" data-phase={scan.phase} data-editing={open ? 'true' : 'false'}>
      <ScanCardHead
        title={title}
        scanning={scanning}
        elapsedMs={scan.elapsedMs}
        measuredInMs={m.kind !== 'exact' && scan.totalMs > 0 && !m.locked ? scan.totalMs : null}
        onRemeasure={!m.locked && m.kind !== 'exact' ? scan.restart : undefined}
      />
      <div ref={scrollRef} className={styles.scroll} data-card-scroll="">
        <div className={styles.body} data-compact={open ? 'true' : 'false'}>
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
        {m.needsReview != null && m.kind !== 'exact' && !scanning ? (
          <div className={styles.note} data-tone="review" role="status">
            <strong>{liftMeasure.needsReview}</strong>
            {m.needsReview.reasons.map((r) => (
              <span key={r} className={styles.reason}>
                {liftMeasure.reviewReason[r]}
              </span>
            ))}
          </div>
        ) : null}
        {edgeCue !== null && m.kind !== 'exact' && !scanning ? (
          <p className={styles.note} data-tone="edge-cue">
            {edgeCue}
          </p>
        ) : null}
        {m.roof3d != null && m.kind !== 'exact' && !scanning ? (
          <p className={styles.note} data-source="solar-3d">
            {legal.solar3dAttribution}
          </p>
        ) : null}
        {(m.roof3d?.lidarEdges?.applied === true || m.roof3d?.lidarFusion?.applied === true) && m.kind !== 'exact' && !scanning ? (
          <p className={styles.note} data-source="usgs-lidar">
            {legal.usgsLidarAttribution}
          </p>
        ) : null}
        {m.roof3d?.lidarFusion?.applied === true && m.roof3d.lidarFusion.addedPlanSqFt > 0 && m.kind !== 'exact' && !scanning ? (
          <p className={styles.note} data-tone="lidar-added">
            {liftMeasure.lidarAdded(m.roof3d.lidarFusion.addedPlanSqFt)}
          </p>
        ) : null}
        {open ? (
          <div id={adjustId} className={styles.adjust}>
            {panels}
            <Button variant="ghost" className={styles.done} onClick={done}>
              {liftMeasure.done}
            </Button>
          </div>
        ) : null}
      </div>
      {!scanning && model !== null && quote !== null ? <Sections model={model} quote={quote} locked={locked} editing={open} /> : null}
      {!scanning && quote?.sectionsReset ? (
        <p className={styles.note} data-tone="reset" role="status">
          {liftMeasure.sectionsReset}
        </p>
      ) : null}
      {!scanning ? (
        <div className={styles.foot}>
          {panels !== null ? (
            <Button
              ref={toggleRef}
              variant="ghost"
              className={styles.footButton}
              aria-expanded={open}
              aria-controls={open ? adjustId : undefined}
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
    </section>
  );
}

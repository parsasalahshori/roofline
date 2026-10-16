import { Banner, Button } from '@roofline/ui';
import { WINDOW_SIZE_CLASSES, type WindowCounts, type WindowMeasurementView, type WindowSizeClass } from '@roofline/shared';
import { useId, type ReactNode } from 'react';
import { measureWindows as copy, windowPhotos } from '../../../copy/measureWindows.ts';
import cardStyles from '../lift/MeasureCard.module.css';
import { ScanCardHead } from '../lift/ScanCardHead.tsx';
import { shownShare, stageAt, type ScanTimer } from '../lift/scan.ts';
import { totalOf } from './model.ts';
import styles from './WindowsWindow.module.css';

/** The plan of the walls: a box as long as the front and as deep as the rest of the perimeter allows, traced by the scan. */
export function WallsPlan({ walls, drawn, floors }: { walls: NonNullable<WindowMeasurementView['walls']>; drawn: number; floors: number | null }) {
  const front = walls.frontWallFt !== null && walls.frontWallFt > 0 ? walls.frontWallFt : walls.perimeterFt / 4;
  const depth = Math.max(walls.perimeterFt / 2 - front, front * 0.3);
  const scale = 64 / Math.max(front, depth);
  const w = front * scale;
  const h = depth * scale;
  const x = (80 - w) / 2;
  const y = (72 - h) / 2;
  return (
    <div className={styles.walls} data-walls-plan="">
      <svg viewBox="0 0 80 72" width="80" height="72" role="img" aria-label={copy.wallsPlanLabel(walls.perimeterFt, walls.frontWallFt)} focusable="false">
        <rect x={x} y={y} width={w} height={h} className={styles.wallsRect} pathLength={1} style={{ strokeDasharray: 1, strokeDashoffset: 1 - drawn }} />
        {/* The front wall: the side the photo looks at */}
        {drawn >= 1 ? <line x1={x} y1={y + h} x2={x + w} y2={y + h} className={styles.wallsFront} /> : null}
      </svg>
      <span className={styles.wallsText}>
        <strong>{copy.wallsAround(walls.perimeterFt * Math.min(1, drawn))}</strong>
        {walls.frontWallFt !== null && drawn >= 1 ? <span>{copy.wallsFront(walls.frontWallFt)}</span> : null}
        {walls.wallHeightFt !== null && drawn >= 1 ? <span>{copy.wallsHigh(walls.wallHeightFt)}</span> : null}
        {floors !== null && drawn >= 1 ? <span>{copy.floors(floors)}</span> : null}
      </span>
    </div>
  );
}

/**
 * The card under the photo: what the scan is doing while it plays, then the windows: "About N windows, estimated from
 * the walls" (or the front windows measured plus the rest estimated), how they were worked out, the table by size,
 * floors, the photo's date and who found the front windows. Adjust opens the controls.
 */
export function WindowsCard({
  v,
  counts,
  scan,
  tookMs,
  editing,
  onEdit,
  panels,
  notes,
  captured,
  tools = false,
  fromPhotos = false,
  photos = null,
  onAddPhotos,
}: {
  v: WindowMeasurementView;
  counts: WindowCounts;
  scan: ScanTimer;
  tookMs: number;
  editing: boolean;
  onEdit: (next: boolean) => void;
  panels: ReactNode;
  /** The review and missing notes, under the numbers. */
  notes: ReactNode;
  captured: string | null;
  /** The Street View tools are on (front windows can be marked on the photo). */
  tools?: boolean;
  /** "I photographed every window": the count is the photos'. */
  fromPhotos?: boolean;
  /** The photographed windows and the button that adds them. */
  photos?: ReactNode;
  /** Opens "Photograph windows". */
  onAddPhotos?: (() => void) | undefined;
}) {
  const adjustId = useId();
  const scanning = scan.phase === 'scanning';
  const share = scanning ? shownShare(scan.progress) : 1;
  const stage = stageAt(scan.progress);
  const title = scanning ? (stage === 'tracing' ? copy.stage.tracing(v.walls?.perimeterFt ?? null) : copy.stage[stage]) : copy.measuredBy;
  const t = totalOf(counts);
  const total = t.measured + t.estimated;
  const shown = Math.round(total * share);
  const covers = t.measured > 0 ? 'sides-and-back' : (v.estimated?.covers ?? 'all-sides');
  const anyMarked = v.windows.some((w) => w.source === 'marked') || (v.adjustments.marked?.length ?? 0) > 0;
  const anyFound = v.windows.some((w) => (w.source ?? 'detector') === 'detector');
  const foundBy =
    v.detector === 'stand-in' && anyFound ? copy.foundBy.standIn : anyMarked ? copy.foundBy.marked : anyFound ? copy.foundBy.detector : copy.foundBy.none;
  const open = editing && !scanning;
  const walls = v.walls ?? null;
  const estimate = v.estimated === null ? null : WINDOW_SIZE_CLASSES.reduce((n, c) => n + v.estimated!.bySizeClass[c], 0);
  const floorsFrom = walls?.floorsFrom ?? (v.stories === null ? 'assumed' : 'height-map');
  // The floors as the estimate took them: one is assumed when there are no heights.
  const floors = v.stories ?? (floorsFrom === 'assumed' ? 1 : null);
  // Shown as a range when the estimate is unsure and nothing was measured, photographed or typed in.
  const range = !scanning && t.measured === 0 && !fromPhotos && estimate !== null && total === estimate ? (v.estimated?.range ?? null) : null;
  const basis =
    walls !== null
      ? copy.wallsBasis({
          perimeterFt: walls.perimeterFt,
          wallHeightFt: floorsFrom === 'assumed' ? null : walls.wallHeightFt,
          floors,
          floorsFrom,
          lowWingFt: walls.lowWingFt ?? 0,
          outlineFrom: walls.outlineFrom ?? 'footprint',
          windows: estimate,
          range: v.estimated?.range ?? null,
          covers: v.estimated?.covers ?? 'all-sides',
        })
      : null;

  return (
    <section className={`${cardStyles.card} ${styles.card}`} aria-label={copy.statsLabel} data-windows-card="" data-phase={scan.phase} data-editing={open ? 'true' : 'false'}>
      <ScanCardHead
        title={title}
        scanning={scanning}
        elapsedMs={scan.elapsedMs}
        measuredInMs={tookMs > 0 ? tookMs : null}
        onRemeasure={scan.restart}
      />
      <div className={cardStyles.scroll}>
        {open ? null : (
        <div className={styles.cardBody}>
          <div className={cardStyles.big}>
            <span className={cardStyles.label}>{fromPhotos ? windowPhotos.fromPhotos : t.measured === 0 ? copy.fromWalls : t.estimated === 0 ? copy.measuredOnly(Math.round(t.measured * share)) : copy.toReplace}</span>
            <span className={cardStyles.squaresRow}>
              {t.measured === 0 && !fromPhotos ? <span className={styles.about}>{copy.about}</span> : null}
              <span className={cardStyles.squares} data-stat="windows" data-range={range !== null ? `${range.low}-${range.high}` : undefined}>
                {range !== null ? copy.range(range.low, range.high) : shown}
              </span>
              <span className={cardStyles.unit}>{copy.windowsUnit(range !== null ? range.high : total)}</span>
            </span>
            {range !== null ? <span className={cardStyles.sqft}>{copy.mostLikely(total)}</span> : null}
            {t.measured > 0 && t.estimated > 0 ? (
              <span className={cardStyles.sqft}>{copy.measuredAndEstimated(Math.round(t.measured * share), Math.round(t.estimated * share))}</span>
            ) : null}
          </div>
          <SizeTable counts={counts} share={share} covers={covers} />
        </div>
        )}
        {!scanning && !open ? (
          <dl className={styles.facts}>
            {basis !== null ? (
              <div className={styles.fact} data-fact="basis">
                <dt>{copy.basisLabel}</dt>
                <dd>{basis}</dd>
              </div>
            ) : null}
            <div className={styles.fact} data-fact="floors">
              <dt>{copy.floorsCell}</dt>
              <dd>{floors !== null ? copy.floorsWithSource(floors, floorsFrom) : copy.unknown}</dd>
            </div>
            <div className={styles.fact}>
              <dt>{copy.imageryCell}</dt>
              <dd>{captured ?? copy.unknown}</dd>
            </div>
            {tools || anyMarked || anyFound ? (
              <div className={styles.fact}>
                <dt>{copy.foundByCell}</dt>
                <dd>
                  <span className={styles.detectorChip} data-detector={v.detector ?? 'none'}>
                    {foundBy}
                  </span>
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        {!scanning && !open ? photos : null}
        {!scanning && !open ? notes : null}
        {v.estimated === null && !scanning && t.estimated === 0 ? <Banner tone="info">{copy.noEstimate}</Banner> : null}
        {open ? (
          <div id={adjustId} className={cardStyles.adjust}>
            {panels}
            <Button variant="ghost" className={cardStyles.done} onClick={() => onEdit(false)}>
              {copy.done}
            </Button>
          </div>
        ) : null}
      </div>
      {!scanning ? (
        <div className={cardStyles.foot}>
          <Button
            variant="ghost"
            className={cardStyles.footButton}
            aria-expanded={open}
            aria-controls={open ? adjustId : undefined}
            onClick={() => onEdit(!editing)}
          >
            {copy.adjust}
            <svg className={cardStyles.chevron} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
              <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
          {onAddPhotos !== undefined ? (
            <Button variant="ghost" className={`${cardStyles.footButton} ${styles.addPhotos}`} onClick={onAddPhotos}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                <path d="M2 5.5h2.5L6 3.5h4l1.5 2H14V13H2Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                <circle cx="8" cy="9" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              {windowPhotos.add}
            </Button>
          ) : null}
          <span className={cardStyles.kind} data-kind={t.measured > 0 ? 'measured' : 'estimate'}>
            {copy.estimateTag}
          </span>
        </div>
      ) : null}
    </section>
  );
}

/** Windows by size: measured on the front, estimated (marked as such), and the total. */
function SizeTable({ counts, share, covers }: { counts: WindowCounts; share: number; covers: 'all-sides' | 'sides-and-back' }) {
  const part = (n: number) => Math.round(n * share);
  return (
    <table className={styles.table} aria-label={copy.tableLabel}>
      <thead>
        <tr>
          <th scope="col">{copy.sizeHead}</th>
          <th scope="col">{copy.measuredHead}</th>
          <th scope="col" data-estimated="">
            {covers === 'all-sides' ? copy.estimatedAll : copy.estimatedSidesBack}
          </th>
          <th scope="col">{copy.totalHead}</th>
        </tr>
      </thead>
      <tbody>
        {WINDOW_SIZE_CLASSES.map((c: WindowSizeClass) => (
          <tr key={c} data-size-class={c}>
            <th scope="row">
              {copy.sizeClass[c]}
              <span className={styles.classHint}>{copy.sizeClassHint[c]}</span>
            </th>
            <td data-col="measured">{part(counts[c].measured)}</td>
            <td data-col="estimated" data-estimated="">
              {part(counts[c].estimated)}
            </td>
            <td data-col="total">{part(counts[c].measured + counts[c].estimated)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

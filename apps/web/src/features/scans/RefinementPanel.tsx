import { Button, Icon, type IconName } from '@roofline/ui';
import { type ScanDetailView, windowSizeLabel } from '@roofline/shared';
import { scanReview } from '../../copy/scanReview.ts';
import apple from './apple.module.css';
import styles from './ScanReview.module.css';

const sizeText = (w: number | null, h: number | null) => (w === null || h === null ? null : windowSizeLabel(w, h).replace(' x ', ' × '));

type Row = { icon: IconName; tone?: 'good' | 'warn' | 'bad'; name: string; detail?: string; value?: string; spin?: boolean };

/** What the refinement says about itself, one row each: where it is, the poses, the AI, the size, the marks, the time. */
export function refinementRows(scan: Pick<ScanDetailView, 'refinement' | 'status' | 'result'>): Row[] {
  const r = scan.refinement;
  if (r === null || r === undefined) return [];
  const rows: Row[] = [];
  if (r.state === 'queued') rows.push({ icon: 'refresh', name: scanReview.refineQueued, detail: scanReview.refineQueuedBody, value: scanReview.refineWaiting, spin: true });
  else if (r.state === 'running') rows.push({ icon: 'refresh', name: scanReview.refineRunning, detail: scanReview.refineRunningBody, value: scanReview.refineWorking, spin: true });
  else if (r.state === 'failed') rows.push({ icon: 'alert', tone: 'bad', name: scanReview.refineFailed, detail: scanReview.refineFailedBody(r.error ?? ''), value: undefined });
  else if (r.poseSource === 'colmap') {
    rows.push({ icon: 'check', tone: 'good', name: scanReview.refineColmap, detail: scanReview.refineColmapBody(scan.result.refined?.colmapFrames ?? r.colmap?.registered ?? 0, scan.result.refined?.frames ?? r.colmap?.total ?? 0, r.colmap?.alignmentRmsCm ?? null), value: scanReview.refineDone });
  } else rows.push({ icon: 'target', tone: 'warn', name: scanReview.refineArkit, detail: r.poseNote ?? scanReview.refineArkitDefault, value: scanReview.refineDone });

  if (r.state === 'done') {
    const ok = r.frames.filter((f) => f.state === 'ok').length;
    rows.push({ icon: 'camera', name: scanReview.aiTitle, detail: r.frames.length === 0 ? scanReview.aiNone : scanReview.aiBody(ok, r.frames.length), value: r.frames.length === 0 ? undefined : scanReview.aiMarks(r.aiMarks.length) });
    const after = sizeText(scan.result.widthIn, scan.result.heightIn);
    const before = sizeText(r.firstWidthIn, r.firstHeightIn);
    if (after !== null) rows.push({ icon: 'ruler', name: scanReview.refineSize, ...(before !== null && { detail: scanReview.refineSizeBefore(before) }), value: `${after} ${scanReview.sizeUnit}` });
    rows.push({ icon: 'pin', name: scanReview.refineMarks, detail: scanReview.refineMarksBody(r.alternatives.length, r.dropped.length) });
    if (r.timings !== null) rows.push({ icon: 'clock', name: scanReview.refineTime, value: scanReview.refineTook(r.timings.totalMs / 1000) });
  }
  return rows;
}

/** The inspector's card for the server's refinement, with the button that runs it again. */
export function RefinementPanel({ scan, onRerun, busy }: { scan: ScanDetailView; onRerun: () => void; busy: boolean }) {
  const rows = refinementRows(scan);
  if (rows.length === 0 && scan.mayRefine !== true) return null;
  return (
    <section aria-label={scanReview.refineTitle}>
      <h3 className={apple.groupTitle}>{scanReview.refineTitle}</h3>
      {rows.length > 0 ? (
        <ul className={apple.group}>
          {rows.map((row) => {
            const tone = row.tone === 'good' ? styles.good : row.tone === 'warn' ? styles.warn : row.tone === 'bad' ? styles.bad : undefined;
            return (
              <li key={row.name} className={styles.rowItem} data-two={row.detail !== undefined ? 'true' : undefined}>
                <Icon name={row.icon} size={18} className={`${tone ?? ''} ${row.spin === true ? styles.spin : ''}`.trim() || undefined} />
                <span>
                  <span className={styles.rowName}>{row.name}</span>
                  {row.detail !== undefined ? <p className={styles.rowDetail}>{row.detail}</p> : null}
                </span>
                {row.value !== undefined ? <span className={`${styles.rowValue} ${tone ?? ''}`.trim()}>{row.value}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {scan.mayRefine === true ? (
        <>
          <div className={styles.refineAction}>
            <Button variant="default" size="lg" busy={busy} onClick={onRerun}>
              <Icon name="refresh" size={18} />
              {scanReview.refineRerun}
            </Button>
          </div>
          <p className={apple.footnote}>{scanReview.refineRerunHelp}</p>
        </>
      ) : null}
    </section>
  );
}

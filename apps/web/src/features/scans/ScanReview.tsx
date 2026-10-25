import { Banner, Button, Field, Icon, IconButton, Skeleton, Toggle, UiLink } from '@roofline/ui';
import {
  computeScanResult,
  type ScanCorner,
  type ScanDetailView,
  type ScanFrameView,
  type ScanMark,
  SCAN_CORNERS,
  SCAN_GATE_LABELS,
  windowSizeLabel,
} from '@roofline/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { ApiError } from '../../api/client.ts';
import { scanReview } from '../../copy/scanReview.ts';
import { AppPage } from '../../shell/AppPage.tsx';
import { useExpediteScan, useFinalizeScan, useSaveMarks, useScan, useSubmitScan } from './api.ts';
import apple from './apple.module.css';
import { SlaChip, StatusChip } from './Chips.tsx';
import { FrameCanvas } from './FrameCanvas.tsx';
import styles from './ScanReview.module.css';
import { markOf, marksOfFrame, moveMark, placeMark, removeMark, sameMarks } from './scanMarks.ts';
import { scanTitle } from './ScanQueue.tsx';
import { useNow } from './useNow.ts';

const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const sizeText = (w: number | null, h: number | null) => (w === null || h === null ? null : windowSizeLabel(w, h).replace(' x ', ' × '));
const messageOf = (error: unknown) => (error instanceof ApiError && error.message !== '' ? error.message : scanReview.actionFailed);

/** The names the frames go by: Frame 1, Frame 2 ..., and the close-up of a corner. */
function frameNames(frames: readonly ScanFrameView[]): Map<string, string> {
  let regular = 0;
  return new Map(
    frames.map((f) => {
      if (f.kind === 'closeup') return [f.frameId, scanReview.closeupName(scanReview.corners[f.corner ?? 0] ?? '')];
      regular += 1;
      return [f.frameId, scanReview.frameName(regular)];
    }),
  );
}

function Loading() {
  return (
    <div className={styles.main} role="status" aria-label={scanReview.loading}>
      <Skeleton width="40%" height="2rem" />
      <Skeleton width="70%" height="1rem" />
      <Skeleton width="100%" height="14rem" />
    </div>
  );
}

export function ScanReview() {
  const { scanId = '' } = useParams();
  const query = useScan(scanId);
  return (
    <AppPage app="scans" bare>
      <div className={apple.root}>
        <div className={styles.page}>
          {query.data ? (
            <Body key={query.data.id} scan={query.data} />
          ) : query.isError ? (
            <div className={styles.main} role="alert">
              <UiLink href="/scans" className={styles.back}>
                <Icon name="chevl" size={22} />
                {scanReview.back}
              </UiLink>
              <p className={styles.note}>{query.error instanceof ApiError && query.error.status === 404 ? scanReview.notFound : scanReview.loadFailedOne}</p>
            </div>
          ) : (
            <Loading />
          )}
        </div>
      </div>
    </AppPage>
  );
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function Body({ scan }: { scan: ScanDetailView }) {
  const [params, setParams] = useSearchParams();
  const now = useNow(30_000);
  const names = useMemo(() => frameNames(scan.frames), [scan.frames]);
  const frameId = params.get('frame');
  const frameIndex = scan.frames.findIndex((f) => f.frameId === frameId);
  const frame = frameIndex >= 0 ? scan.frames[frameIndex]! : null;

  // The draft: the marks as the reviewer has them now. The result is worked out here with the same code the server uses.
  const [marks, setMarks] = useState<ScanMark[]>(scan.marks);
  const marksRef = useRef(marks);
  const lastSaved = useRef<ScanMark[]>(scan.marks);
  const comp = useMemo(() => computeScanResult(scan.frames, marks, scan.wall), [scan.frames, scan.wall, marks]);
  const editable = scan.mayEdit;

  const [zoom, setZoom] = useState(true);
  const [armed, setArmed] = useState<ScanCorner | null>(null);
  const [selected, setSelected] = useState<ScanCorner | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const saveMarks = useSaveMarks(scan.id);
  const submit = useSubmitScan(scan.id);
  const finalize = useFinalizeScan(scan.id);
  const expedite = useExpediteScan(scan.id);

  const change = useCallback((next: ScanMark[]) => {
    marksRef.current = next;
    setMarks(next);
  }, []);

  /** Sends the draft when it differs from what the server has. False when it could not be saved. */
  const flush = useCallback(async (): Promise<boolean> => {
    const sending = marksRef.current;
    if (sameMarks(sending, lastSaved.current)) return true;
    setSaveState('saving');
    try {
      await saveMarks.mutateAsync(sending);
      lastSaved.current = sending;
      setSaveState(sameMarks(marksRef.current, sending) ? 'saved' : 'saving');
      return true;
    } catch {
      setSaveState('error');
      return false;
    }
  }, [saveMarks]);

  // Autosave: a moment after the last change
  useEffect(() => {
    if (!editable || sameMarks(marks, lastSaved.current)) return;
    const timer = setTimeout(() => void flush(), 700);
    return () => clearTimeout(timer);
  }, [marks, editable, flush]);

  const open = useCallback(
    (id: string | null) => {
      setArmed(null);
      setSelected(null);
      setParams(id === null ? {} : { frame: id }, { replace: false });
    },
    [setParams],
  );

  // Arrow keys between frames and Escape back to the grid, while a frame is open and nothing is being typed
  useEffect(() => {
    if (frame === null) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.closest('svg') !== null)) return;
      if (event.key === 'Escape') open(null);
      else if (event.key === 'ArrowRight' && frameIndex < scan.frames.length - 1) open(scan.frames[frameIndex + 1]!.frameId);
      else if (event.key === 'ArrowLeft' && frameIndex > 0) open(scan.frames[frameIndex - 1]!.frameId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [frame, frameIndex, scan.frames, open]);

  const failed = comp.quality.failed.length > 0;
  const size = sizeText(comp.widthIn, comp.heightIn);
  const phone = scan.phoneResult === null ? null : sizeText(scan.phoneResult.widthIn, scan.phoneResult.heightIn);
  const title = scanTitle(scan);
  const secondsLeft = scan.expedite || !['needs_review', 'in_review', 'junior_done'].includes(scan.status) ? null : Math.round((new Date(scan.slaDueAt).getTime() - now.getTime()) / 1000);
  const first = scan.junior?.name ?? '';

  async function onSubmit() {
    setError(null);
    if (!(await flush())) return;
    try {
      await submit.mutateAsync();
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function onFinalize(outcome: 'measured' | 'visit_required') {
    setError(null);
    if (!(await flush())) return;
    const text = reason.trim();
    try {
      await finalize.mutateAsync({ outcome, ...(text !== '' && { reason: text }), ...(outcome === 'measured' && failed && { override: true }) });
      setReason('');
    } catch (e) {
      setError(messageOf(e));
    }
  }

  const regularFrames = scan.frames.filter((f) => f.kind === 'regular');
  const closeupFrames = scan.frames.filter((f) => f.kind === 'closeup');

  const tile = (f: ScanFrameView) => {
    const n = marksOfFrame(marks, f.frameId).length;
    return (
      <li key={f.frameId}>
        <UiLink href={`/scans/${scan.id}?frame=${encodeURIComponent(f.frameId)}`} className={styles.tile} aria-label={scanReview.openFrame(names.get(f.frameId) ?? '')}>
          <FrameCanvas frame={f} frameName={names.get(f.frameId) ?? ''} marks={marks} comp={comp} mode="thumb" />
          <span className={styles.tileText}>
            <span className={styles.tileName}>{names.get(f.frameId)}</span>
            <span className={styles.tileMeta}>{scanReview.frameMarks(n)}</span>
          </span>
        </UiLink>
      </li>
    );
  };

  const pick = (c: ScanCorner) => {
    if (frame === null) return;
    if (markOf(marks, frame.frameId, c) !== undefined) {
      setArmed(null);
      setSelected(selected === c ? null : c);
    } else {
      setSelected(null);
      setArmed(armed === c ? null : c);
    }
  };

  return (
    <div className={styles.shell}>
      <div className={styles.main}>
        <UiLink href="/scans" className={styles.back}>
          <Icon name="chevl" size={22} />
          {scanReview.back}
        </UiLink>
        <header className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
          <p className={styles.address}>{[scan.homeowner, scan.address].filter((p) => p !== null && p !== '').join('  ·  ')}</p>
          <div className={styles.chips}>
            <StatusChip status={scan.status} />
            <SlaChip secondsLeft={secondsLeft} expedite={scan.expedite} />
          </div>
        </header>

        {frame === null ? (
          <>
            <section className={styles.section} aria-label={scanReview.frameGroup.regular}>
              <div className={styles.sectionHead}>
                <h3>{scanReview.frameGroup.regular}</h3>
                <span className={styles.sectionNote}>{scanReview.frames(regularFrames.length)}</span>
              </div>
              <ul className={styles.grid} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {regularFrames.map(tile)}
              </ul>
            </section>
            {closeupFrames.length > 0 ? (
              <section className={styles.section} aria-label={scanReview.frameGroup.closeup}>
                <div className={styles.sectionHead}>
                  <h3>{scanReview.frameGroup.closeup}</h3>
                  <span className={styles.sectionNote}>{scanReview.frames(closeupFrames.length)}</span>
                </div>
                <ul className={styles.grid} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {closeupFrames.map(tile)}
                </ul>
              </section>
            ) : null}
          </>
        ) : (
          <section className={styles.viewer} aria-label={names.get(frame.frameId)}>
            <div className={styles.viewerBar}>
              <Button variant="quiet" size="lg" onClick={() => open(null)}>
                <Icon name="layers" size={18} />
                {scanReview.viewerBack}
              </Button>
              <h3 className={styles.viewerName}>{names.get(frame.frameId)}</h3>
              <div className={styles.viewerNav}>
                <span className={styles.saveState} data-state={saveState} role="status">
                  {saveState === 'saving' ? scanReview.saving : saveState === 'saved' ? scanReview.saved : saveState === 'error' ? scanReview.saveFailed : null}
                </span>
                <IconButton label={scanReview.viewerPrev} icon={<Icon name="chevl" size={22} />} disabled={frameIndex === 0} onClick={() => open(scan.frames[frameIndex - 1]!.frameId)} />
                <IconButton label={scanReview.viewerNext} icon={<Icon name="chev" size={22} />} disabled={frameIndex === scan.frames.length - 1} onClick={() => open(scan.frames[frameIndex + 1]!.frameId)} />
              </div>
            </div>
            <FrameCanvas
              frame={frame}
              frameName={names.get(frame.frameId) ?? ''}
              marks={marks}
              comp={comp}
              mode="edit"
              zoom={zoom}
              editable={editable}
              armed={armed}
              selected={selected}
              onSelect={setSelected}
              onMove={(c, x, y) => change(moveMark(marksRef.current, frame.frameId, c, x, y))}
              onPlace={(c, x, y) => {
                change(placeMark(marksRef.current, frame.frameId, c, x, y));
                setArmed(null);
                setSelected(c);
              }}
              onRemove={(c) => {
                change(removeMark(marksRef.current, frame.frameId, c));
                setSelected(null);
              }}
            />
            <ul className={apple.group}>
              <li className={styles.toggleRow}>
                <Toggle label={scanReview.zoomLabel} checked={zoom} onChange={setZoom} />
              </li>
            </ul>
            {editable ? (
              <>
                <div className={styles.picker} role="group" aria-label={scanReview.pickCorner}>
                  {SCAN_CORNERS.map((c) => {
                    const has = markOf(marks, frame.frameId, c) !== undefined;
                    const active = armed === c || selected === c;
                    return (
                      <Button key={c} variant={active ? 'primary' : 'quiet'} size="lg" className={styles.pickerBtn} aria-pressed={active} onClick={() => pick(c)}>
                        {has ? <Icon name="check" size={16} /> : <Icon name="plus" size={16} />}
                        {scanReview.corners[c]}
                      </Button>
                    );
                  })}
                </div>
                <div className={styles.viewerBar}>
                  <Button
                    variant="ghost"
                    size="lg"
                    disabled={selected === null || markOf(marks, frame.frameId, selected) === undefined}
                    onClick={() => {
                      if (selected === null) return;
                      change(removeMark(marksRef.current, frame.frameId, selected));
                      setSelected(null);
                    }}
                  >
                    <Icon name="minus" size={18} />
                    {scanReview.removeMark}
                  </Button>
                  <Button variant="ghost" size="lg" disabled={sameMarks(marks, scan.marksOriginal)} onClick={() => change(scan.marksOriginal)}>
                    <Icon name="undo" size={18} />
                    {scanReview.resetMarks}
                  </Button>
                </div>
              </>
            ) : (
              <p className={styles.help}>{scanReview.viewerReadOnly}</p>
            )}
            <ul className={styles.legend}>
              <li>
                <span className={styles.legendRing} aria-hidden="true" />
                {scanReview.legendMark}
              </li>
              <li>
                <span className={styles.legendDiamond} aria-hidden="true" />
                {scanReview.legendProjected}
              </li>
            </ul>
            {editable ? <p className={styles.help}>{scanReview.viewerHelp}</p> : null}
          </section>
        )}
      </div>

      <aside className={styles.inspector} aria-label={scanReview.title}>
        <section aria-label={scanReview.size}>
          <div className={styles.size}>
            <p className={styles.sizeLabel}>{scanReview.size}</p>
            {size !== null ? (
              <>
                <p className={styles.sizeBig}>
                  {size}
                  <span className={styles.sizeUnit}>{scanReview.sizeUnit}</span>
                </p>
                {phone !== null ? <p className={styles.sizeSub}>{scanReview.phoneSaid(phone)}</p> : null}
              </>
            ) : (
              <>
                <p className={styles.sizeBig}>{scanReview.sizeNone}</p>
                <p className={styles.sizeSub}>{scanReview.sizeNoneBody}</p>
              </>
            )}
          </div>
        </section>

        <section aria-label={scanReview.cornersTitle}>
          <h3 className={apple.groupTitle}>{scanReview.cornersTitle}</h3>
          <ul className={apple.group}>
            {SCAN_CORNERS.map((c) => {
              const pc = comp.perCorner[c]!;
              const few = pc.used < 3;
              return (
                <li key={c} className={styles.rowItem}>
                  <Icon name={few ? 'alert' : 'target'} size={18} className={few ? styles.warn : undefined} />
                  <span className={styles.rowName}>{scanReview.corners[c]}</span>
                  <span className={styles.rowValue}>{pc.used === 0 ? scanReview.cornerNone : scanReview.cornerRow(pc.used, pc.rmsPx)}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-label={scanReview.checksTitle}>
          <h3 className={apple.groupTitle}>{scanReview.checksTitle}</h3>
          <ul className={apple.group}>
            {comp.gates.map((g) => {
              const tone = g.passed ? styles.good : g.warning ? styles.warn : styles.bad;
              return (
                <li key={g.code} className={styles.rowItem} data-two="true">
                  <Icon name={g.passed ? 'check' : 'alert'} size={18} className={tone} />
                  <span>
                    <span className={styles.rowName}>{SCAN_GATE_LABELS[g.code]}</span>
                    <p className={styles.rowDetail}>{g.detail}</p>
                  </span>
                  <span className={`${styles.rowValue} ${tone}`}>{g.passed ? scanReview.checkPass : g.warning ? scanReview.checkWarn : scanReview.checkFail}</span>
                </li>
              );
            })}
          </ul>
        </section>

        {scan.mayEdit || scan.status === 'junior_done' || scan.status === 'needs_review' || scan.status === 'in_review' ? (
          <section aria-label={scanReview.slaTitle}>
            <ul className={apple.group}>
              <li className={styles.toggleRow}>
                <Toggle label={scanReview.expediteLabel} checked={scan.expedite} disabled={expedite.isPending} onChange={(next) => expedite.mutate(next)} />
              </li>
            </ul>
            <p className={apple.footnote}>{scanReview.expediteHelp}</p>
          </section>
        ) : null}

        <section aria-label={scanReview.finalizeTitle}>
          <div className={styles.actions}>
            {error !== null ? <Banner tone="danger">{error}</Banner> : null}
            {scan.status === 'measured' || scan.status === 'visit_required' ? (
              <div className={styles.outcome}>
                <StatusChip status={scan.status} />
                <p className={styles.note}>{scan.status === 'measured' ? scanReview.outcomeMeasured : scanReview.outcomeVisit}</p>
                {scan.outcomeReason ? <p className={styles.note}>{scanReview.outcomeReason(scan.outcomeReason)}</p> : null}
                {scan.overrode ? <p className={styles.note}>{scanReview.override}</p> : null}
              </div>
            ) : scan.status === 'junior_done' ? (
              scan.mayFinalize ? (
                <>
                  <h3 className={styles.actionsTitle}>{scanReview.finalizeTitle}</h3>
                  {first !== '' ? <p className={styles.note}>{scanReview.submitted(first)}</p> : null}
                  <Field
                    label={scanReview.reasonLabel}
                    multiline
                    rows={3}
                    value={reason}
                    maxLength={500}
                    onChange={(event) => setReason(event.target.value)}
                    help={failed ? scanReview.reasonOverride : scanReview.reasonHelp}
                  />
                  <div className={styles.buttons}>
                    <Button
                      variant="primary"
                      size="lg"
                      busy={finalize.isPending}
                      disabled={comp.widthIn === null || (failed && reason.trim().length < 3)}
                      onClick={() => void onFinalize('measured')}
                    >
                      <Icon name="check" size={18} />
                      {scanReview.measured}
                    </Button>
                    <Button variant="default" size="lg" busy={finalize.isPending} disabled={reason.trim() === ''} onClick={() => void onFinalize('visit_required')}>
                      <Icon name="truck" size={18} />
                      {scanReview.visitRequired}
                    </Button>
                  </div>
                </>
              ) : (
                <p className={styles.note}>{first !== '' ? `${scanReview.submitted(first)} ${scanReview.waitingSenior}` : scanReview.waitingSenior}</p>
              )
            ) : (
              <>
                <p className={styles.note}>{scanReview.submitHelp}</p>
                <Button variant="primary" size="lg" busy={submit.isPending} onClick={() => void onSubmit()}>
                  <Icon name="check2" size={18} />
                  {scanReview.submit}
                </Button>
              </>
            )}
          </div>
        </section>

        <section aria-label={scanReview.detailsTitle}>
          <h3 className={apple.groupTitle}>{scanReview.detailsTitle}</h3>
          <ul className={apple.group}>
            {[
              [scanReview.detailRows.homeowner, scan.homeowner ?? scanReview.homeownerUnknown],
              [scanReview.detailRows.address, scan.address],
              [scanReview.detailRows.device, scan.device ?? ''],
              [scanReview.detailRows.app, scan.app ?? ''],
              [scanReview.detailRows.sent, when(scan.createdAt)],
              [scanReview.detailRows.frames, `${scan.frames.length}`],
            ]
              .filter(([, value]) => value !== '')
              .map(([key, value]) => (
                <li key={key} className={styles.kv}>
                  <span className={styles.kvKey}>{key}</span>
                  <span className={styles.kvValue}>{value}</span>
                </li>
              ))}
          </ul>
        </section>

        <section aria-label={scanReview.historyTitle}>
          <h3 className={apple.groupTitle}>{scanReview.historyTitle}</h3>
          <ul className={apple.group}>
            {[...scan.history].reverse().map((h, i) => (
              <li key={`${h.at}-${i}`} className={styles.kv}>
                <span className={styles.history}>
                  {scanReview.historyAction[h.action]}
                  <br />
                  <span className={styles.historyWhen}>{h.byName ?? scanReview.historySystem}</span>
                </span>
                <span className={`${styles.kvValue} ${styles.historyWhen}`}>{when(h.at)}</span>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}

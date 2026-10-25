import type { HouseVisual, Placement, WindowDesign } from '@roofline/shared';
import { Banner, Button, Icon, IconButton, Segmented, Skeleton } from '@roofline/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { ApiError } from '../../../api/client.ts';
import { backofficeDesigner as copy } from '../../../copy/backofficeDesigner.ts';
import { preparePhoto } from '../../measure/windows/preparePhoto.ts';
import { useBackofficeCatalog, useBackofficeQuote } from '../designer/api.ts';
import '../apple.css';
import '../designer/apple.css';
import { chosenOption } from '../designer/pricing.ts';
import { Group } from '../designer/primitives.tsx';
import { SAVE_DEBOUNCE_MS, useAutosave } from '../designer/useAutosave.ts';
import { frameColorHex } from '../drawing/colors.ts';
import { newLayoutId } from '../drawing/layout.ts';
import { UnitDrawing } from '../drawing/UnitDrawing.tsx';
import { uploadHousePhoto, useHouseVisual, usePutVisual, visualPhotoSrc, type VisualPut } from './api.ts';
import { defaultCorners } from './homography.ts';
import { PlacementStage, type StageItem } from './PlacementStage.tsx';
import styles from './Visualizer.module.css';

const t = copy.visualizer;
const DEFAULT_PHOTO_ASPECT = 4 / 3;

type View = 'before' | 'after';
const REASONS = { type: t.wrongType, heic: t.heic, 'too-big': t.tooBig } as const;

/** Where the nth new unit starts on the photo, so two units do not sit on top of each other. */
const startAt = (n: number): [number, number] => [0.3 + 0.4 * (n % 2), 0.45 + 0.08 * Math.floor(n / 2)];

/** The house photo: take or choose a photo, lay each drawn unit on it by four corners, and compare before and after. */
export function Visualizer() {
  const { quoteId = '' } = useParams();
  const quote = useBackofficeQuote(quoteId);
  const catalog = useBackofficeCatalog();
  const visual = useHouseVisual(quoteId);
  const put = usePutVisual(quoteId);
  const autosave = useAutosave<VisualPut>((body) => put.mutateAsync(body), SAVE_DEBOUNCE_MS);
  const [local, setLocal] = useState<VisualPut | null>(null);
  const localRef = useRef<VisualPut | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<View>('after');
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [aspect, setAspect] = useState(DEFAULT_PHOTO_ASPECT);
  const [uploading, setUploading] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState('');
  const cameraInput = useRef<HTMLInputElement>(null);
  const libraryInput = useRef<HTMLInputElement>(null);

  const fromServer = useMemo<VisualPut | null>(() => (visual.data ? { photoUploadId: visual.data.photoUploadId, placements: visual.data.placements } : null), [visual.data]);
  const current: VisualPut | null = local ?? fromServer;
  useEffect(() => {
    localRef.current = current;
  });

  useEffect(() => () => void (photoUrl && URL.revokeObjectURL(photoUrl)), [photoUrl]);

  function update(fn: (v: VisualPut) => VisualPut) {
    const base = localRef.current;
    if (!base) return;
    const next = fn(base);
    localRef.current = next;
    setLocal(next);
    autosave.change(next);
  }

  // The photo's own shape, for starting placements the right proportions
  useEffect(() => {
    const src = photoUrl ?? (current?.photoUploadId ? visualPhotoSrc(quoteId, current.photoUploadId) : null);
    if (!src || typeof Image === 'undefined') return;
    const img = new Image();
    img.onload = () => img.naturalWidth > 0 && img.naturalHeight > 0 && setAspect(img.naturalWidth / img.naturalHeight);
    img.src = src;
  }, [photoUrl, current?.photoUploadId, quoteId]);

  const designs = quote.data?.designs ?? [];
  const designOf = (id: string): WindowDesign | undefined => designs.find((d) => d.id === id);
  const items: StageItem[] = useMemo(() => {
    if (!current || !catalog.data) return [];
    return current.placements.flatMap((placement) => {
      const design = quote.data?.designs.find((d) => d.id === placement.designId);
      return design ? [{ placement, design, frameColor: frameColorHex(chosenOption(catalog.data, design, 'exterior-color')?.value) }] : [];
    });
  }, [current, catalog.data, quote.data]);

  if (quote.isError || catalog.isError || visual.isError) {
    return (
      <div className="bo-apple">
        <div className={styles.state}>
          <Banner tone="danger" action={<Button variant="default" size="sm" onClick={() => { void quote.refetch(); void catalog.refetch(); void visual.refetch(); }}>{t.tryAgain}</Button>}>
            {t.loadFailed}
          </Banner>
        </div>
      </div>
    );
  }
  if (!current || !catalog.data || !quote.data) {
    return (
      <div className="bo-apple">
        <div className={styles.state} aria-busy="true">
          <Skeleton />
        </div>
      </div>
    );
  }

  const photoSrc = photoUrl ?? (current.photoUploadId ? visualPhotoSrc(quoteId, current.photoUploadId) : null);
  const placedIds = new Set(current.placements.map((p) => p.designId));
  const unplaced = designs.filter((d) => !placedIds.has(d.id));
  const aspectOf = (d: WindowDesign) => d.widthIn / d.heightIn;

  const place = (design: WindowDesign) => {
    const [cx, cy] = startAt(current.placements.length);
    const placement: Placement = { id: newLayoutId(), designId: design.id, corners: defaultCorners(aspectOf(design), aspect, cx, cy) };
    update((v) => ({ ...v, placements: [...v.placements, placement] }));
    setActiveId(placement.id);
    setView('after');
  };
  const reset = (placement: Placement) => {
    const design = designOf(placement.designId);
    if (!design) return;
    const index = Math.max(current.placements.findIndex((p) => p.id === placement.id), 0);
    const [cx, cy] = startAt(index);
    update((v) => ({ ...v, placements: v.placements.map((p) => (p.id === placement.id ? { ...p, corners: defaultCorners(aspectOf(design), aspect, cx, cy) } : p)) }));
  };
  const remove = (placement: Placement) => update((v) => ({ ...v, placements: v.placements.filter((p) => p.id !== placement.id) }));
  const setCorners = (id: string, corners: Placement['corners']) => update((v) => ({ ...v, placements: v.placements.map((p) => (p.id === id ? { ...p, corners } : p)) }));

  async function choose(file: File | undefined) {
    if (!file) return;
    setUploadError('');
    const prepared = await preparePhoto(file);
    if (!prepared.ok) {
      setUploadError(REASONS[prepared.reason]);
      return;
    }
    setPhotoUrl(URL.createObjectURL(prepared.file));
    setUploading(0);
    try {
      const saved: HouseVisual = await uploadHousePhoto(quoteId, prepared.file, setUploading);
      update((v) => ({ ...v, photoUploadId: saved.photoUploadId }));
    } catch (error) {
      setUploadError(error instanceof ApiError && error.message !== '' ? error.message : t.uploadFailed);
    } finally {
      setUploading(null);
    }
  }

  const saveText = autosave.state === 'saving' || autosave.state === 'waiting' ? t.saving : autosave.state === 'error' ? t.saveFailed : t.saved;

  return (
    <div className="bo-apple">
      <div className={styles.page}>
        <header className={styles.toolbar}>
          <div className={styles.toolbarTitle}>
            <h1 className={styles.title}>{t.title}</h1>
            <p className={styles.sub}>
              {quote.data.customerName}, {quote.data.address}
            </p>
          </div>
          <div className={styles.toolbarEnd}>
            <p className={styles.saveState} aria-live="polite" data-state={autosave.state}>
              <Icon name={autosave.state === 'error' ? 'alert' : autosave.state === 'idle' || autosave.state === 'saved' ? 'check' : 'clock'} size={16} />
              {saveText}
            </p>
            <Button variant="default" href={`/backoffice/quotes/${encodeURIComponent(quoteId)}`}>
              <Icon name="chevl" size={18} />
              {t.back}
            </Button>
          </div>
        </header>

        <div className={styles.layout}>
          <main className={styles.main}>
            {uploadError ? <Banner tone="danger">{uploadError}</Banner> : null}
            {uploading !== null ? (
              <p className={styles.uploading} role="status">
                {t.uploading}
              </p>
            ) : null}

            {photoSrc ? (
              <>
                <div className={styles.viewBar}>
                  <Segmented<View> label={t.view} value={view} onChange={setView} options={[{ value: 'before', label: t.before }, { value: 'after', label: t.after }]} />
                </div>
                <PlacementStage photoSrc={photoSrc} items={items} activeId={activeId} after={view === 'after'} onActive={setActiveId} onCorners={setCorners} />
                {view === 'after' && items.length > 0 ? <p className={styles.hint}>{t.placementsNote}</p> : null}
              </>
            ) : (
              <div className={styles.empty}>
                <Icon name="camera" size={22} />
                <h2 className={styles.emptyTitle}>{t.emptyTitle}</h2>
                <p className={styles.emptyBody}>{t.emptyBody}</p>
              </div>
            )}
          </main>

          <aside className={styles.side}>
            <Group title={t.title}>
              <div className={styles.photoActions}>
                <Button variant="primary" onClick={() => cameraInput.current?.click()}>
                  <Icon name="camera" size={18} />
                  {t.takePhoto}
                </Button>
                <Button variant="default" onClick={() => libraryInput.current?.click()}>
                  <Icon name="upload" size={18} />
                  {photoSrc ? t.changePhoto : t.uploadPhoto}
                </Button>
              </div>
              <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden data-testid="camera-input" onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ''; }} />
              <input ref={libraryInput} type="file" accept="image/*" hidden data-testid="library-input" onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ''; }} />
            </Group>

            {designs.length === 0 ? (
              <p className={styles.note}>{t.noUnits}</p>
            ) : (
              <>
                <Group title={t.placements}>
                  {current.placements.length === 0 ? <p className={styles.rowNote}>{t.nonePlaced}</p> : null}
                  {current.placements.map((p) => {
                    const design = designOf(p.designId);
                    if (!design) return null;
                    return (
                      <div key={p.id} className={styles.placementRow} data-active={p.id === activeId ? 'true' : undefined}>
                        <Button variant="ghost" className={styles.pick} aria-pressed={p.id === activeId} onClick={() => setActiveId(p.id)}>
                          <span className={styles.mini}>
                            <UnitDrawing design={design} frameColor={frameColorHex(chosenOption(catalog.data, design, 'exterior-color')?.value)} />
                          </span>
                          <span>{design.label}</span>
                        </Button>
                        <IconButton label={t.resetLabel(design.label)} icon={<Icon name="undo" size={18} />} onClick={() => reset(p)} />
                        <IconButton label={t.removeLabel(design.label)} icon={<Icon name="x" size={18} />} onClick={() => remove(p)} />
                      </div>
                    );
                  })}
                </Group>
                <Group title={t.add} footer={unplaced.length === 0 ? t.allPlaced : t.addNote}>
                  {unplaced.map((d) => (
                    <div key={d.id} className={styles.placementRow}>
                      <Button variant="ghost" className={styles.pick} disabled={!photoSrc} onClick={() => place(d)}>
                        <span className={styles.mini}>
                          <UnitDrawing design={d} frameColor={frameColorHex(chosenOption(catalog.data, d, 'exterior-color')?.value)} />
                        </span>
                        <span>{d.label}</span>
                      </Button>
                      <IconButton label={`${t.add}: ${d.label}`} icon={<Icon name="plus" size={18} />} disabled={!photoSrc} onClick={() => place(d)} />
                    </div>
                  ))}
                </Group>
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

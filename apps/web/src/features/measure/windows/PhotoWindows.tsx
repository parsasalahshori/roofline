import { Banner, Button, Checkbox, ProgressBar } from '@roofline/ui';
import { photoWindowKey, type PhotoWindow, type PhotoWindowInput, type WindowPhotoUpload } from '@roofline/shared';
import { createPortal } from 'react-dom';
import { Suspense, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { measureWindows, windowPhotos as copy } from '../../../copy/measureWindows.ts';
import { UPLOAD_MAX_BYTES, UPLOAD_TYPES, uploadSrc, uploadWindowPhoto } from './api.ts';
import { PhotoMeasure, type WindowGroup } from './PhotoMeasure.tsx';
import { usePhotoEngine } from './photoEngine.tsx';
import { asMeasurement, inchesFraction, plusMinusFraction, type LocalSheetSize } from './photoModel.ts';
import { SheetPrint } from './SheetPrint.tsx';
import type { ArResult } from './ar/ArMeasure.tsx';
import { useArSupport } from './ar/arSupport.ts';
import { LazyArMeasure } from './ar/lazy.ts';
import flow from './PhotoWindows.module.css';

/** One photo on its way up, up, or refused. */
export type UploadItem = {
  key: string;
  name: string;
  file: File;
  /** A local copy to show at once (null where the browser cannot make one). */
  preview: string | null;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  error: string | null;
  upload: WindowPhotoUpload | null;
};

function checkFile(file: File): string | null {
  const type = file.type.toLowerCase();
  const heic = /\.(heic|heif)$/i.test(file.name);
  if (!(UPLOAD_TYPES as readonly string[]).includes(type) && !heic) return copy.wrongType;
  if (file.size > UPLOAD_MAX_BYTES) return copy.tooBig;
  return null;
}

/** The photos taken on this screen, uploading one by one with their progress, plus those the server already has. */
export function useWindowUploads(measurementId: string, serverUploads: readonly WindowPhotoUpload[] | undefined) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const seq = useRef(0);
  const patch = (key: string, next: Partial<UploadItem>) => setItems((list) => list.map((it) => (it.key === key ? { ...it, ...next } : it)));
  /** Sends one row's file; resolves with the upload, or rejects (the row then shows why). */
  const send = (key: string, file: File): Promise<WindowPhotoUpload> => {
    const refused = checkFile(file);
    if (refused !== null) {
      patch(key, { status: 'error', error: refused });
      return Promise.reject(new Error(refused));
    }
    patch(key, { status: 'uploading', error: null, progress: 0 });
    return uploadWindowPhoto(measurementId, file, (share) => patch(key, { progress: share })).then(
      (upload) => {
        patch(key, { status: 'done', progress: 1, upload });
        return upload;
      },
      (error: unknown) => {
        const message = error instanceof Error && error.message !== '' ? error.message : copy.uploadFailed;
        patch(key, { status: 'error', error: message });
        throw new Error(message);
      },
    );
  };
  const rowFor = (file: File): UploadItem => {
    seq.current += 1;
    const preview = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
    return { key: `u${seq.current}`, name: file.name, file, preview, progress: 0, status: 'uploading', error: null, upload: null };
  };
  const add = (files: FileList | File[]) => {
    const made = [...files].map(rowFor);
    setItems((current) => [...current, ...made]);
    // After the rows exist, so each one's progress has somewhere to go
    queueMicrotask(() => made.forEach((it) => void send(it.key, it.file).catch(() => undefined)));
  };
  /** One file sent now (the picture AR keeps, or the photo taken for it), listed like the others. */
  const uploadFile = (file: File): Promise<WindowPhotoUpload> => {
    const it = rowFor(file);
    setItems((current) => [...current, it]);
    return send(it.key, it.file);
  };
  const retry = (key: string) => {
    const it = items.find((x) => x.key === key);
    if (it) void send(key, it.file).catch(() => undefined);
  };
  const remove = (key: string) => setItems((list) => list.filter((x) => x.key !== key));
  useEffect(
    () => () => {
      for (const it of items) if (it.preview !== null) URL.revokeObjectURL?.(it.preview);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on leaving the screen
    [],
  );
  // Every upload the screen knows: the server's, then this session's that finished
  const known = new Map<string, WindowPhotoUpload>();
  for (const u of serverUploads ?? []) known.set(u.id, u);
  for (const it of items) if (it.upload !== null) known.set(it.upload.id, it.upload);
  const srcFor = (uploadId: string) => items.find((it) => it.upload?.id === uploadId)?.preview ?? uploadSrc(measurementId, uploadId);
  return { items, add, uploadFile, retry, remove, uploads: [...known.values()], srcFor };
}

export type Uploads = ReturnType<typeof useWindowUploads>;

/** Where the flow is: taking photos, or sizing the window on one of them. */
export type FlowAt = { step: 'capture' } | { step: 'print' } | { step: 'ar' } | { step: 'measure'; uploadId: string; windowId: string | null; ar?: ArResult };

/** The windows photographed so far (several photos of one window are one window), named as the card names them. */
export function windowGroups(inputs: readonly PhotoWindowInput[]): WindowGroup[] {
  const out: WindowGroup[] = [];
  for (const w of inputs) {
    const key = photoWindowKey(w);
    if (out.some((g) => g.key === key)) continue;
    out.push({ key, name: w.label ?? copy.untitled(out.length + 1) });
  }
  return out;
}

/** The 3-step how-to for the measuring sheet, with the way to print it. */
export function SheetHowTo({ onPrint }: { onPrint: () => void }) {
  const arSupport = useArSupport();
  return (
    <section className={flow.howTo} aria-labelledby="sheet-how-to">
      <h3 id="sheet-how-to" className={flow.howToTitle}>
        {copy.howToTitle}
      </h3>
      <ol className={flow.steps}>
        {copy.howTo.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className={flow.bigWindow}>{copy.bigWindow}</p>
      <Button variant="ghost" className={flow.printButton} onClick={onPrint}>
        {copy.printOpen}
      </Button>
      {arSupport === 'unsupported' ? (
        <p className={flow.arNote} data-ar-note="">
          {copy.arOnlyAndroid}
        </p>
      ) : null}
    </section>
  );
}

/**
 * "Photograph windows", full screen on a phone: take photos (camera or library), watch them upload, then size each
 * window on its photo. Saving a window comes back here, ready for the next photo.
 */
export function PhotoWindowsFlow({
  at,
  go,
  uploads,
  inputs,
  saved,
  live = [],
  onSave,
  onDelete,
  onClose,
}: {
  at: FlowAt;
  go: (next: FlowAt) => void;
  uploads: Uploads;
  inputs: readonly PhotoWindowInput[];
  saved: readonly PhotoWindow[];
  /** The photographed windows as sized now (to combine several photos of one window). */
  live?: readonly PhotoWindow[];
  onSave: (input: PhotoWindowInput, local?: LocalSheetSize) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  // After a save: "Add another photo of …" makes the next new photo another photo of that window
  const [lastSaved, setLastSaved] = useState<WindowGroup | null>(null);
  const [nextKey, setNextKey] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const titleId = 'photo-windows-title';
  const arSupport = useArSupport();
  const measuring = at.step === 'measure' ? uploads.uploads.find((u) => u.id === at.uploadId) : undefined;
  const editing = at.step === 'measure' && at.windowId !== null ? (inputs.find((w) => w.id === at.windowId) ?? null) : null;

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.currentTarget.files;
    if (files && files.length > 0) uploads.add(files);
    e.currentTarget.value = '';
  };

  // Escape closes the flow (or goes back from a photo)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (at.step !== 'capture') go({ step: 'capture' });
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [at.step, go, onClose]);

  // Over the whole app (top bar and dock too): on a phone it is the screen
  return createPortal(
    <div className={flow.overlay} role="dialog" aria-modal="true" aria-labelledby={titleId} data-photo-flow={at.step}>
      <header className={flow.head}>
        {at.step !== 'capture' ? (
          <Button variant="ghost" className={flow.headButton} onClick={() => go({ step: 'capture' })}>
            {copy.back}
          </Button>
        ) : null}
        <h2 id={titleId} className={flow.title}>
          {at.step === 'measure' || at.step === 'ar' ? copy.measureTitle : at.step === 'print' ? copy.printTitle : copy.title}
        </h2>
        <Button variant="ghost" className={flow.headButton} onClick={onClose}>
          {copy.close}
        </Button>
      </header>
      <div className={flow.body}>
        {at.step === 'measure' && measuring !== undefined ? (
          <PhotoMeasure
            key={`${at.uploadId}:${at.windowId ?? 'new'}`}
            upload={measuring}
            src={uploads.srcFor(measuring.id)}
            initial={editing}
            saved={editing !== null ? (saved.find((w) => w.id === editing.id) ?? null) : null}
            groups={windowGroups(inputs)}
            live={live}
            defaultWindowKey={editing === null ? (nextKey ?? undefined) : undefined}
            initialAr={at.ar}
            uploadPhoto={uploads.uploadFile}
            srcFor={uploads.srcFor}
            onSave={(input, local) => {
              if (local !== undefined) onSave(input, local);
              else onSave(input);
              const key = photoWindowKey(input);
              const named = windowGroups([...inputs.filter((w) => w.id !== input.id), input]).find((g) => g.key === key);
              setLastSaved(named ?? null);
              setNextKey(null);
              go({ step: 'capture' });
            }}
            onCancel={() => go({ step: 'capture' })}
            onDelete={
              editing !== null
                ? () => {
                    onDelete(editing.id);
                    go({ step: 'capture' });
                  }
                : undefined
            }
          />
        ) : at.step === 'print' ? (
          <SheetPrint onClose={() => go({ step: 'capture' })} />
        ) : at.step === 'ar' ? (
          <div className={flow.capture}>
            <p className={flow.guidance}>{copy.arHint}</p>
            <Suspense fallback={<p role="status">{copy.arStarting}</p>}>
              <LazyArMeasure photo={null} uploadPhoto={uploads.uploadFile} onResult={(r) => go({ step: 'measure', uploadId: r.upload.id, windowId: null, ar: r })} />
            </Suspense>
          </div>
        ) : (
          <div className={flow.capture}>
            <p className={flow.guidance}>{copy.guidance}</p>
            <SheetHowTo onPrint={() => go({ step: 'print' })} />
            {arSupport === 'supported' ? (
              <Button className={flow.pickButton} data-ar-start="" onClick={() => go({ step: 'ar' })}>
                {copy.arStartFromCapture}
              </Button>
            ) : null}
            {lastSaved !== null ? (
              <Button
                variant="ghost"
                className={flow.another}
                data-another={lastSaved.key}
                aria-pressed={nextKey === lastSaved.key}
                onClick={() => {
                  setNextKey(lastSaved.key);
                  cameraRef.current?.click();
                }}
              >
                {copy.anotherPhoto(lastSaved.name)}
              </Button>
            ) : null}
            <div className={flow.pick}>
              <Button className={flow.pickButton} onClick={() => cameraRef.current?.click()}>
                {copy.take}
              </Button>
              <Button variant="ghost" className={flow.pickButton} onClick={() => libraryRef.current?.click()}>
                {copy.library}
              </Button>
              <input ref={cameraRef} className="visually-hidden" type="file" accept="image/*" capture="environment" multiple aria-label={copy.takeLabel} onChange={onFiles} />
              <input ref={libraryRef} className="visually-hidden" type="file" accept="image/*" multiple aria-label={copy.libraryLabel} onChange={onFiles} />
            </div>
            <UploadList uploads={uploads} inputs={inputs} go={go} />
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function UploadList({ uploads, inputs, go }: { uploads: Uploads; inputs: readonly PhotoWindowInput[]; go: (next: FlowAt) => void }) {
  const fromSession = new Set(uploads.items.flatMap((it) => (it.upload !== null ? [it.upload.id] : [])));
  const older = uploads.uploads.filter((u) => !fromSession.has(u.id));
  if (uploads.items.length === 0 && older.length === 0) return <p className={flow.empty}>{copy.noUploads}</p>;
  const measuredOn = (uploadId: string) => inputs.filter((w) => w.uploadId === uploadId).length;
  const row = (key: string, src: string | null, title: string, body: ReactNode, actions: ReactNode, state: string) => (
    <li key={key} className={flow.upload} data-upload={state}>
      {src !== null ? <img className={flow.thumb} src={src} alt="" /> : <span className={flow.thumb} aria-hidden="true" />}
      <div className={flow.uploadText}>
        <span className={flow.uploadName}>{title}</span>
        {body}
      </div>
      <div className={flow.uploadActions}>{actions}</div>
    </li>
  );
  return (
    <ul className={flow.uploads}>
      {older.map((u, index) => {
        const n = index + 1;
        const count = measuredOn(u.id);
        return row(
          u.id,
          uploads.srcFor(u.id),
          copy.photoNumber(n),
          count > 0 ? <span className={flow.measured}>{copy.measured}</span> : <span>{copy.uploaded}</span>,
          <Button onClick={() => go({ step: 'measure', uploadId: u.id, windowId: null })}>{copy.measure}</Button>,
          'done',
        );
      })}
      {uploads.items.map((it, index) => {
        const n = older.length + index + 1;
        const count = it.upload !== null ? measuredOn(it.upload.id) : 0;
        return row(
          it.key,
          it.preview ?? (it.upload !== null ? uploads.srcFor(it.upload.id) : null),
          copy.photoNumber(n),
          it.status === 'uploading' ? (
            <ProgressBar value={Math.round(it.progress * 100)} max={100} label={copy.uploading(it.name)} />
          ) : it.status === 'error' ? (
            <div role="alert" className={flow.uploadError}>
              <Banner tone="danger">{it.error ?? copy.uploadFailed}</Banner>
            </div>
          ) : count > 0 ? (
            <span className={flow.measured}>{copy.measured}</span>
          ) : (
            <span>{copy.uploaded}</span>
          ),
          it.status === 'done' && it.upload !== null ? (
            <Button onClick={() => go({ step: 'measure', uploadId: it.upload!.id, windowId: null })}>{copy.measure}</Button>
          ) : it.status === 'error' ? (
            <>
              <Button variant="ghost" onClick={() => uploads.retry(it.key)}>
                {copy.retry}
              </Button>
              <Button variant="ghost" onClick={() => uploads.remove(it.key)}>
                {copy.remove}
              </Button>
            </>
          ) : null,
          it.status,
        );
      })}
    </ul>
  );
}

/** The size the card shows for one window: its photos combined (the engine's median and spread), or its one photo. */
function groupSize(
  photos: readonly PhotoWindow[],
  combine: ((ms: ReturnType<typeof asMeasurement>[]) => { widthIn: number; heightIn: number; spreadIn: { width: number; height: number } } | null) | null,
): { text: string; detail: string | null } | null {
  if (photos.length === 0) return null;
  const exact = photos.some((p) => p.scale.kind === 'sheet' || p.scale.kind === 'ar');
  if (photos.length === 1) {
    const p = photos[0]!;
    if (!exact) return { text: measureWindows.size(p.widthIn, p.heightIn), detail: null };
    const u = p.uncertaintyIn ? Math.max(p.uncertaintyIn.width, p.uncertaintyIn.height) : null;
    return { text: copy.sizeExact(inchesFraction(p.widthIn), inchesFraction(p.heightIn)), detail: u !== null ? copy.plusMinus(plusMinusFraction(u)) : null };
  }
  const c = combine?.(photos.map(asMeasurement)) ?? null;
  if (c === null) {
    const mid = (vs: number[]) => [...vs].sort((a, b) => a - b)[Math.floor((vs.length - 1) / 2)]!;
    const w = mid(photos.map((p) => p.widthIn));
    const h = mid(photos.map((p) => p.heightIn));
    return { text: exact ? copy.sizeExact(inchesFraction(w), inchesFraction(h)) : measureWindows.size(w, h), detail: copy.photosOfWindow(photos.length) };
  }
  return {
    text: copy.sizeExact(inchesFraction(c.widthIn), inchesFraction(c.heightIn)),
    detail: copy.groupSpread(photos.length, plusMinusFraction(Math.max(c.spreadIn.width, c.spreadIn.height))),
  };
}

/**
 * The photographed windows in the card, one row per window (its photos combined): thumbnail, name, size and a "Photo"
 * chip; tap to edit, a checkbox to leave one out, delete; and "I photographed every window".
 */
export function PhotoWindowsList({
  windows,
  inputs,
  excluded,
  coverAll,
  srcFor,
  onOpen,
  onToggle,
  onDelete,
  onCoverAll,
}: {
  windows: readonly PhotoWindow[];
  inputs: readonly PhotoWindowInput[];
  excluded: ReadonlySet<string>;
  coverAll: boolean;
  srcFor: (uploadId: string) => string;
  onOpen: (w: PhotoWindowInput) => void;
  /** Leave a window (all its photos) out of the quote, or put it back. */
  onToggle: (ids: string[]) => void;
  onDelete: (ids: string[]) => void;
  onCoverAll: (next: boolean) => void;
}) {
  const groups = windowGroups(inputs);
  const several = groups.some((g) => inputs.filter((w) => photoWindowKey(w) === g.key).length > 1);
  const engine = usePhotoEngine(several);
  if (inputs.length === 0) return null;
  return (
    <section className={flow.list} aria-labelledby="photo-windows-list">
      <h3 id="photo-windows-list" className={flow.listTitle}>
        {copy.listTitle}
      </h3>
      <ul className={flow.rows}>
        {groups.map((g) => {
          const members = inputs.filter((w) => photoWindowKey(w) === g.key);
          const first = members[0]!;
          const ids = members.map((w) => w.id);
          const sized = members.flatMap((m) => windows.filter((w) => w.id === m.id));
          const shown = groupSize(sized, engine.cv === null ? null : (ms) => engine.cv!.combine(ms));
          const size = shown !== null ? shown.text : measureWindows.sizing;
          const out = ids.every((id) => excluded.has(id));
          return (
            <li key={g.key} className={flow.row} data-photo-window={first.id} data-photos={members.length} data-out={out ? 'true' : undefined}>
              <Button variant="ghost" className={flow.rowOpen} aria-label={copy.rowLabel(g.name, size)} onClick={() => onOpen(first)}>
                <img className={flow.rowThumb} src={srcFor(first.uploadId)} alt="" />
                <span className={flow.rowText}>
                  <span className={flow.rowName}>
                    {g.name}
                    <span className={flow.chip}>{members.length > 1 ? copy.photosOfWindow(members.length) : copy.chip}</span>
                  </span>
                  <span className={flow.rowSize}>{out ? measureWindows.leftOut : size}</span>
                  {!out && shown?.detail ? <span className={flow.rowDetail}>{shown.detail}</span> : null}
                </span>
              </Button>
              <Checkbox label={copy.inQuote} checked={!out} onChange={() => onToggle(ids)} />
              <Button variant="ghost" className={flow.rowDelete} aria-label={copy.deleteRow(g.name)} onClick={() => onDelete(ids)}>
                {copy.remove}
              </Button>
            </li>
          );
        })}
      </ul>
      <Checkbox label={copy.coverAll} description={copy.coverAllHint} checked={coverAll} onChange={onCoverAll} />
    </section>
  );
}

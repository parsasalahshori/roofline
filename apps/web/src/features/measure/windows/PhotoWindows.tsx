import { Banner, Button, Checkbox, ProgressBar } from '@roofline/ui';
import type { PhotoWindow, PhotoWindowInput, WindowPhotoUpload } from '@roofline/shared';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { measureWindows, windowPhotos as copy } from '../../../copy/measureWindows.ts';
import { UPLOAD_MAX_BYTES, UPLOAD_TYPES, uploadSrc, uploadWindowPhoto } from './api.ts';
import { PhotoMeasure } from './PhotoMeasure.tsx';
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
  const send = (key: string, file: File) => {
    const refused = checkFile(file);
    if (refused !== null) {
      patch(key, { status: 'error', error: refused });
      return;
    }
    patch(key, { status: 'uploading', error: null, progress: 0 });
    uploadWindowPhoto(measurementId, file, (share) => patch(key, { progress: share })).then(
      (upload) => patch(key, { status: 'done', progress: 1, upload }),
      (error: unknown) => patch(key, { status: 'error', error: error instanceof Error && error.message !== '' ? error.message : copy.uploadFailed }),
    );
  };
  const add = (files: FileList | File[]) => {
    const list = [...files];
    const made = list.map((file): UploadItem => {
      seq.current += 1;
      const preview = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
      return { key: `u${seq.current}`, name: file.name, file, preview, progress: 0, status: 'uploading', error: null, upload: null };
    });
    setItems((current) => [...current, ...made]);
    // After the rows exist, so each one's progress has somewhere to go
    queueMicrotask(() => made.forEach((it) => send(it.key, it.file)));
  };
  const retry = (key: string) => {
    const it = items.find((x) => x.key === key);
    if (it) send(key, it.file);
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
  return { items, add, retry, remove, uploads: [...known.values()], srcFor };
}

export type Uploads = ReturnType<typeof useWindowUploads>;

/** Where the flow is: taking photos, or sizing the window on one of them. */
export type FlowAt = { step: 'capture' } | { step: 'measure'; uploadId: string; windowId: string | null };

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
  onSave,
  onDelete,
  onClose,
}: {
  at: FlowAt;
  go: (next: FlowAt) => void;
  uploads: Uploads;
  inputs: readonly PhotoWindowInput[];
  saved: readonly PhotoWindow[];
  onSave: (input: PhotoWindowInput) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const titleId = 'photo-windows-title';
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
      if (at.step === 'measure') go({ step: 'capture' });
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [at.step, go, onClose]);

  // Over the whole app (top bar and dock too): on a phone it is the screen
  return createPortal(
    <div className={flow.overlay} role="dialog" aria-modal="true" aria-labelledby={titleId} data-photo-flow={at.step}>
      <header className={flow.head}>
        {at.step === 'measure' ? (
          <Button variant="ghost" className={flow.headButton} onClick={() => go({ step: 'capture' })}>
            {copy.back}
          </Button>
        ) : null}
        <h2 id={titleId} className={flow.title}>
          {at.step === 'measure' ? copy.measureTitle : copy.title}
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
            onSave={(input) => {
              onSave(input);
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
        ) : (
          <div className={flow.capture}>
            <p className={flow.guidance}>{copy.guidance}</p>
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

/**
 * The photographed windows in the card: thumbnail, name, size and a "Photo" chip; tap to edit, a checkbox to leave
 * one out, delete; and "I photographed every window".
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
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
  onCoverAll: (next: boolean) => void;
}) {
  if (inputs.length === 0) return null;
  return (
    <section className={flow.list} aria-labelledby="photo-windows-list">
      {
        <>
          <h3 id="photo-windows-list" className={flow.listTitle}>
            {copy.listTitle}
          </h3>
          <ul className={flow.rows}>
            {inputs.map((input, i) => {
              const sized = windows.find((w) => w.id === input.id);
              const name = input.label ?? copy.untitled(i + 1);
              const size = sized !== undefined ? measureWindows.size(sized.widthIn, sized.heightIn) : measureWindows.sizing;
              const out = excluded.has(input.id);
              return (
                <li key={input.id} className={flow.row} data-photo-window={input.id} data-out={out ? 'true' : undefined}>
                  <Button variant="ghost" className={flow.rowOpen} aria-label={copy.rowLabel(name, size)} onClick={() => onOpen(input)}>
                    <img className={flow.rowThumb} src={srcFor(input.uploadId)} alt="" />
                    <span className={flow.rowText}>
                      <span className={flow.rowName}>
                        {name}
                        <span className={flow.chip}>{copy.chip}</span>
                      </span>
                      <span className={flow.rowSize}>{out ? measureWindows.leftOut : size}</span>
                    </span>
                  </Button>
                  <Checkbox label={copy.inQuote} checked={!out} onChange={() => onToggle(input.id)} />
                  <Button variant="ghost" className={flow.rowDelete} aria-label={copy.deleteRow(name)} onClick={() => onDelete(input.id)}>
                    {copy.remove}
                  </Button>
                </li>
              );
            })}
          </ul>
          <Checkbox label={copy.coverAll} description={copy.coverAllHint} checked={coverAll} onChange={onCoverAll} />
        </>
      }
    </section>
  );
}


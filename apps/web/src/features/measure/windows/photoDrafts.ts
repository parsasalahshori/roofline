// Photographed windows saved on the phone but not yet on the server survive a closed tab: every change to the list is
// kept on this device (pendingStore) until the server's saved list matches it; opening the measurement again with a
// kept list that the server does not have puts it back and saves it, unless the server's list changed since (another
// phone or the office saved over it): then the kept one is dropped, never saved over newer work.
import type { PhotoWindowInput } from '@roofline/shared';
import { useCallback, useEffect, useRef } from 'react';
import { pendingStore, type PendingStore } from './pendingStore.ts';

/** The parts of a window the server keeps (its own sizes and quality are worked out again from these). */
const keyOf = (list: readonly PhotoWindowInput[]) =>
  JSON.stringify(list.map((w) => [w.id, w.uploadId, w.label ?? null, w.windowKey ?? null, w.corners, w.scale]));

export function usePhotoWindowDrafts(
  measurementId: string,
  /** The list as the server has it saved (null while it is not known). */
  serverList: readonly PhotoWindowInput[] | null,
  /** Puts a kept list back on screen and saves it. */
  restore: (list: PhotoWindowInput[]) => void,
  store: PendingStore = pendingStore,
): { keep: (list: PhotoWindowInput[]) => void } {
  const kept = useRef<string | null>(null);
  const checked = useRef<string | null>(null);
  const restoreRef = useRef(restore);
  useEffect(() => {
    restoreRef.current = restore;
  });

  // Opening the measurement: a list kept from a closed tab that the server never got is put back
  useEffect(() => {
    if (measurementId === '' || serverList === null || checked.current === measurementId) return;
    checked.current = measurementId;
    void store.getDraft(measurementId).then((d) => {
      if (d === null) return;
      if (keyOf(d.photoWindows) === keyOf(serverList) || d.base !== keyOf(serverList)) {
        void store.deleteDraft(measurementId);
        return;
      }
      kept.current = keyOf(d.photoWindows);
      restoreRef.current(d.photoWindows);
    });
  }, [measurementId, serverList, store]);

  // The server has the kept list now: nothing to keep
  const serverKey = serverList === null ? null : keyOf(serverList);
  useEffect(() => {
    if (serverKey === null || kept.current === null || serverKey !== kept.current) return;
    kept.current = null;
    void store.deleteDraft(measurementId);
  }, [serverKey, measurementId, store]);

  const keep = useCallback(
    (list: PhotoWindowInput[]) => {
      if (measurementId === '' || serverKey === null) return;
      kept.current = keyOf(list);
      void store.putDraft({ measurementId, photoWindows: list, base: serverKey, savedAt: Date.now() });
    },
    [measurementId, serverKey, store],
  );
  return { keep };
}

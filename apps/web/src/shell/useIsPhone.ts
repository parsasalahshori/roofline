import { useSyncExternalStore } from 'react';

/** Phones are narrower than 768px. The same line the kit's own CSS uses. */
const PHONE_QUERY = '(max-width: 767.98px)';

const hasMatchMedia = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

function subscribe(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => {};
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

const getSnapshot = (): boolean => hasMatchMedia() && window.matchMedia(PHONE_QUERY).matches;

/** False where there is no `matchMedia` (a test environment, a server). */
const getServerSnapshot = (): boolean => false;

/** Is the screen phone-sized? Updates when the window is resized across 768px. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

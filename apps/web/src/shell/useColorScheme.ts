import type { ColorScheme } from '@roofline/ui';
import { useSyncExternalStore } from 'react';

const DARK_QUERY = '(prefers-color-scheme: dark)';

const hasMatchMedia = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

/** The theme the page shows: `data-theme` on the root when it says so, otherwise the system's setting. */
export function currentColorScheme(): ColorScheme {
  if (typeof document !== 'undefined') {
    const forced = document.documentElement.getAttribute('data-theme');
    if (forced === 'dark' || forced === 'light') return forced;
  }
  return hasMatchMedia() && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function subscribe(onChange: () => void): () => void {
  const query = hasMatchMedia() ? window.matchMedia(DARK_QUERY) : null;
  query?.addEventListener('change', onChange);
  const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(onChange);
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    query?.removeEventListener('change', onChange);
    observer?.disconnect();
  };
}

/** Light or dark, following the system setting and `data-theme` on the root. For code that cannot read CSS variables (the map). */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, currentColorScheme, () => 'light');
}

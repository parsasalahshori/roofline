import { applyBrand } from '@roofline/ui';
import { useLayoutEffect } from 'react';

/**
 * Puts the company's one colour into a homeowner page (--brand and its ink, tint, line, text and the focus ring, light and
 * dark, with the contrast worked out) and takes it out when the page goes. Null or an unreadable colour leaves the default.
 * The page reads nothing else from the company's own site: this is the whole of the white label.
 */
export function usePublicBrand(color: string | null | undefined): void {
  useLayoutEffect(() => {
    applyBrand(color ?? null);
    return () => applyBrand(null);
  }, [color]);
}

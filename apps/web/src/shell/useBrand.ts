import { applyBrand, parseColor } from '@roofline/ui';
import { useEffect, useLayoutEffect } from 'react';
import { useMe } from '../api/hooks.ts';
import { useCompany } from '../features/settings/api.ts';

/** The company as the shell shows it: its name, its one colour (null = Roofline's blue), its logo if it has one. */
export type Brand = {
  name: string;
  /** The first letter of each of the first two words: the mark when there is no logo. */
  initials: string;
  /** #rrggbb, or null for the default blue. */
  color: string | null;
  logoUrl: string | null;
  /** "Omaha, NE", or null while it is not known. */
  place: string | null;
};

const cacheKey = (companyId: string) => `roofline.brand.${companyId}`;

/** The colour this browser last saw for the company: the shell paints it before the company's own answer arrives, so a reload does not flash blue. */
function readCached(companyId: string | undefined): string | null {
  if (companyId === undefined) return null;
  try {
    const value = window.localStorage.getItem(cacheKey(companyId));
    return parseColor(value) ? value : null;
  } catch {
    return null;
  }
}

function writeCached(companyId: string, color: string | null): void {
  try {
    if (color === null) window.localStorage.removeItem(cacheKey(companyId));
    else window.localStorage.setItem(cacheKey(companyId), color);
  } catch {
    // A convenience only: storage may be blocked
  }
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => /[\p{L}\p{N}]/u.exec(word)?.[0])
    .filter((letter): letter is string => letter !== undefined)
    .slice(0, 2)
    .map((letter) => letter.toLocaleUpperCase())
    .join('');
}

/**
 * Fills the white-label slot (--brand and friends) from the signed-in company's colour and returns the
 * company's name, mark and place for the rail. The colour comes from the company record (GET /api/company);
 * until it arrives, the one cached for this company is used. Leaving the shell puts the default back.
 */
export function useBrand(): Brand {
  const me = useMe();
  const company = useCompany();
  const companyId = me.data?.company.id;
  const loaded = company.data !== undefined;
  const served = company.data?.brandColor ?? null;
  const color = loaded ? (parseColor(served) ? served : null) : readCached(companyId);

  useLayoutEffect(() => {
    applyBrand(color);
    return () => applyBrand(null);
  }, [color]);

  useEffect(() => {
    if (companyId !== undefined && loaded) writeCached(companyId, color);
  }, [companyId, loaded, color]);

  const name = company.data?.name ?? me.data?.company.name ?? '';
  const city = company.data?.addressCity ?? null;
  const state = company.data?.addressState ?? null;
  return {
    name,
    initials: initialsOf(name),
    color,
    logoUrl: company.data?.logoUrl ?? null,
    place: city ? (state ? `${city}, ${state}` : city) : null,
  };
}

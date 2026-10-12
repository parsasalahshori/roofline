import { useEffect, useRef } from 'react';
import { useMe } from '../api/hooks.ts';

/** A job or a customer the person opened lately, shown first when they search or pick a place. */
export type Recent = { kind: 'job' | 'customer'; id: string; label: string };

/** How many recents are kept, newest first. */
const LIMIT = 8;

const keyFor = (companyId: string) => `roofline.recents.${companyId}`;

function isRecent(value: unknown): value is Recent {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (entry.kind === 'job' || entry.kind === 'customer') && typeof entry.id === 'string' && typeof entry.label === 'string';
}

/** The recents this browser holds for one company. Any read or parse failure gives an empty list. */
export function readRecents(companyId: string): Recent[] {
  try {
    const raw = window.localStorage.getItem(keyFor(companyId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isRecent)
      .map((entry) => ({ kind: entry.kind, id: entry.id, label: entry.label }))
      .slice(0, LIMIT);
  } catch {
    return [];
  }
}

/** Puts `recent` at the front of the company's list, dropping an earlier entry for the same thing. Storage may be blocked; then nothing is kept. */
export function recordRecent(companyId: string, recent: Recent): void {
  try {
    const kept = readRecents(companyId).filter((entry) => !(entry.kind === recent.kind && entry.id === recent.id));
    const next: Recent[] = [{ kind: recent.kind, id: recent.id, label: recent.label }, ...kept].slice(0, LIMIT);
    window.localStorage.setItem(keyFor(companyId), JSON.stringify(next));
  } catch {
    // Recents are a convenience: a failed write is not an error the person should see
  }
}

/** Records `recent` once per mount of the calling screen, as soon as the company is known. */
export function useRecordRecent(recent: Recent): void {
  const companyId = useMe().data?.company.id;
  const recorded = useRef(false);

  useEffect(() => {
    if (companyId === undefined || recorded.current) return;
    recorded.current = true;
    recordRecent(companyId, recent);
  }, [companyId, recent]);
}

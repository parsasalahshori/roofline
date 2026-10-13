import { useEffect, useRef, useState } from 'react';
import type { MeasurementView } from '../types.ts';

const DEFAULT_SCAN_MS = 2600;
const TICK_MS = 80;

/** Roofs already revealed in this browser session: coming back to one does not play the scan again. */
const revealed = new Set<string>();

/** Forgets which roofs were revealed, so each test starts with the scan waiting. */
export function forgetRevealed(): void {
  revealed.clear();
}

/** How long the scan plays. Read at use time so a test can shorten it with VITE_MEASURE_SCAN_MS. */
export function readScanMs(): number {
  const raw: unknown = import.meta.env.VITE_MEASURE_SCAN_MS;
  const ms = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : DEFAULT_SCAN_MS;
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_SCAN_MS;
}

/** Where the reveal stands: waiting for "Measure roof", playing, or finished (numbers and facets showing). */
export type ScanPhase = 'idle' | 'scanning' | 'done';

export type ScanSession = {
  phase: ScanPhase;
  elapsedMs: number;
  /** The facet count the measurement really has, or null when it has none. */
  facets: number | null;
  start: () => void;
};

/**
 * A measurement that is still editable and has an outline is revealed by the scan: the roof is already measured
 * (the numbers come from the saved measurement), the scan only plays it back. A sent, exact or outline-less
 * measurement has nothing to reveal.
 */
export function needsScan(m: MeasurementView): boolean {
  return !m.locked && m.kind !== 'exact' && (m.outline?.[0]?.length ?? 0) >= 3 && !m.drawMode && !revealed.has(m.id);
}

export function useRoofScan(m: MeasurementView): ScanSession {
  const [phase, setPhase] = useState<ScanPhase>(() => (needsScan(m) ? 'idle' : 'done'));
  const [elapsedMs, setElapsedMs] = useState(0);
  const id = m.id;
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    if (phase !== 'scanning') return;
    const total = readScanMs();
    const began = Date.now();
    timer.current = setInterval(() => {
      const elapsed = Math.min(Date.now() - began, total);
      setElapsedMs(elapsed);
      if (elapsed >= total) {
        clearInterval(timer.current);
        revealed.add(id);
        setPhase('done');
      }
    }, TICK_MS);
    return () => clearInterval(timer.current);
  }, [phase, id]);

  return { phase, elapsedMs, facets: m.facets, start: () => setPhase((p) => (p === 'idle' ? 'scanning' : p)) };
}

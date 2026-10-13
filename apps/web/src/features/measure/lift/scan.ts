import { useEffect, useRef, useState } from 'react';
import type { MeasurementView } from '../types.ts';

const DEFAULT_SCAN_MS = 4800;
const TICK_MS = 80;

/** Roofs already revealed in this browser session: coming back to one does not play the scan again. */
const revealed = new Set<string>();

/** Scans playing now, by roof, with when they began: a window that remounts mid-scan picks it up where it was. */
const playing = new Map<string, number>();

/** Forgets which roofs were revealed, so each test starts with the scan waiting. */
export function forgetRevealed(): void {
  revealed.clear();
  playing.clear();
}

/** How long the scan plays. Read at use time so a test can shorten it with VITE_MEASURE_SCAN_MS. */
export function readScanMs(): number {
  const raw: unknown = import.meta.env.VITE_MEASURE_SCAN_MS;
  const ms = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : DEFAULT_SCAN_MS;
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_SCAN_MS;
}

/** Where the reveal stands: waiting for "Measure roof", playing, or finished (numbers and facets showing). */
export type ScanPhase = 'idle' | 'scanning' | 'done';

/** What the scan is doing, in order, by how far it has played. */
export type ScanStage = 'finding' | 'tracing' | 'reading' | 'pricing';
const STAGE_ENDS: [ScanStage, number][] = [
  ['finding', 0.3],
  ['tracing', 0.55],
  ['reading', 0.8],
  ['pricing', 1],
];

export function stageAt(progress: number): ScanStage {
  return (STAGE_ENDS.find(([, end]) => progress < end) ?? STAGE_ENDS[STAGE_ENDS.length - 1]!)[0];
}

/** How much of a measured number shows while the scan plays: none while it finds the roof, all of it once done. */
export function shownShare(progress: number): number {
  const p = Math.min(1, Math.max(0, (progress - 0.3) / 0.6));
  return 1 - (1 - p) ** 3;
}

export type ScanSession = {
  phase: ScanPhase;
  elapsedMs: number;
  totalMs: number;
  /** 0 to 1 while scanning; 1 once done. */
  progress: number;
  /** The facet count the measurement really has, or null when it has none. */
  facets: number | null;
  start: () => void;
  /** Re-measure: plays the scan again over the same saved roof. */
  restart: () => void;
};

/**
 * A measurement that is still editable and has an outline is revealed by the scan: the roof is already measured
 * (the numbers come from the saved measurement), the scan only plays it back. A sent, exact or outline-less
 * measurement has nothing to reveal.
 */
export function needsScan(m: MeasurementView): boolean {
  return !m.locked && m.kind !== 'exact' && (m.outline?.[0]?.length ?? 0) >= 3 && !m.drawMode && !revealed.has(m.id);
}

export function useRoofScan(m: MeasurementView, facets: number | null = m.facets): ScanSession {
  const id = m.id;
  const [phase, setPhase] = useState<ScanPhase>(() => (playing.has(id) ? 'scanning' : needsScan(m) ? 'idle' : 'done'));
  const [elapsedMs, setElapsedMs] = useState(0);
  const [run, setRun] = useState(0);
  const total = readScanMs();
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    if (phase !== 'scanning') return;
    if (!playing.has(id)) playing.set(id, Date.now());
    const tick = () => {
      const began = playing.get(id) ?? Date.now();
      const elapsed = Math.min(Date.now() - began, total);
      setElapsedMs(elapsed);
      if (elapsed >= total) {
        clearInterval(timer.current);
        playing.delete(id);
        revealed.add(id);
        setPhase('done');
      }
    };
    timer.current = setInterval(tick, TICK_MS);
    return () => clearInterval(timer.current);
  }, [phase, id, total, run]);

  const progress = phase === 'done' ? 1 : phase === 'idle' || total === 0 ? 0 : Math.min(elapsedMs / total, 1);
  return {
    phase,
    elapsedMs,
    totalMs: total,
    progress,
    facets,
    start: () => {
      if (phase !== 'idle') return;
      playing.set(id, Date.now());
      setElapsedMs(0);
      setPhase('scanning');
    },
    restart: () => {
      playing.set(id, Date.now());
      setElapsedMs(0);
      setRun((n) => n + 1);
      setPhase('scanning');
    },
  };
}

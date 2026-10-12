import type { JobStage } from './enums.ts';
import { localDate } from './time-zone.ts';

// Lost is the drawer
export const BOARD_STAGES = ['lead', 'inspection', 'proposal', 'won', 'installed'] as const;
export type BoardStage = (typeof BOARD_STAGES)[number];

export const STUCK_STAGES: readonly JobStage[] = ['lead', 'inspection', 'proposal'];
export const BOARD_INSTALLED_DAYS = 30;
export const NEXT_STEP_MAX = 120;
export const LOST_REASON_MAX = 200;

export type StageMove = {
  from: JobStage;
  to: JobStage;
  valueCents: number | null;
  lostReason: string | null;
};

export type StageMoveProblem = {
  field: 'stage' | 'lostReason' | 'valueCents';
  problem: 'installed_needs_won' | 'lost_needs_reason' | 'won_needs_value';
};

export function stageMoveProblem(m: StageMove): StageMoveProblem | null {
  if (m.from === m.to) return null;
  if (m.to === 'installed' && m.from !== 'won' && m.from !== 'installed') {
    return { field: 'stage', problem: 'installed_needs_won' };
  }
  if (m.to === 'lost' && (m.lostReason === null || m.lostReason.trim() === '')) {
    return { field: 'lostReason', problem: 'lost_needs_reason' };
  }
  if (m.to === 'won' && !(m.valueCents !== null && m.valueCents > 0)) {
    return { field: 'valueCents', problem: 'won_needs_value' };
  }
  return null;
}

function dayNumber(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function daysInStage(stageChangedAt: Date, now: Date, timeZone: string): number {
  const from = dayNumber(localDate(stageChangedAt, timeZone));
  const to = dayNumber(localDate(now, timeZone));
  return Math.max(0, Math.round((to - from) / 86400000));
}

export function isStuck(stage: JobStage, days: number, stuckAfterDays: number): boolean {
  return STUCK_STAGES.includes(stage) && days > stuckAfterDays;
}

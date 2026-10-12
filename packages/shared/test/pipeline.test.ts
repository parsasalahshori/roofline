import { describe, expect, test } from 'vitest';
import {
  BOARD_INSTALLED_DAYS,
  BOARD_STAGES,
  LOST_REASON_MAX,
  NEXT_STEP_MAX,
  STUCK_STAGES,
  daysInStage,
  isStuck,
  stageMoveProblem,
  type StageMove,
} from '../src/pipeline.ts';
import { JOB_STAGES, type JobStage } from '../src/enums.ts';
import * as shared from '../src/index.ts';

const CHICAGO = 'America/Chicago';

function move(from: JobStage, to: JobStage, over: Partial<StageMove> = {}): StageMove {
  return { from, to, valueCents: null, lostReason: null, ...over };
}

describe('pipeline constants', () => {
  test('have the exact values', () => {
    expect(BOARD_INSTALLED_DAYS).toBe(30);
    expect(NEXT_STEP_MAX).toBe(120);
    expect(LOST_REASON_MAX).toBe(200);
  });

  test('BOARD_STAGES leaves out lost (lost is the drawer)', () => {
    expect(BOARD_STAGES).not.toContain('lost');
    expect([...BOARD_STAGES]).toEqual(['lead', 'inspection', 'proposal', 'won', 'installed']);
  });

  test('every BOARD_STAGES entry is a job stage', () => {
    for (const stage of BOARD_STAGES) {
      expect(JOB_STAGES).toContain(stage);
    }
  });

  test('STUCK_STAGES is the three open pre-sale stages', () => {
    expect([...STUCK_STAGES]).toEqual(['lead', 'inspection', 'proposal']);
  });

  test('names are exported from the package entry point', () => {
    expect(shared.BOARD_STAGES).toBe(BOARD_STAGES);
    expect(shared.STUCK_STAGES).toBe(STUCK_STAGES);
    expect(shared.BOARD_INSTALLED_DAYS).toBe(30);
    expect(shared.NEXT_STEP_MAX).toBe(120);
    expect(shared.LOST_REASON_MAX).toBe(200);
    expect(shared.stageMoveProblem).toBe(stageMoveProblem);
    expect(shared.daysInStage).toBe(daysInStage);
    expect(shared.isStuck).toBe(isStuck);
  });
});

describe('stageMoveProblem: won needs a value', () => {
  test('lead to won with a positive value is allowed', () => {
    expect(stageMoveProblem(move('lead', 'won', { valueCents: 1500000 }))).toBeNull();
  });

  test.each(['lead', 'inspection', 'proposal'] as const)('%s to won without a value is refused', (from) => {
    for (const valueCents of [null, 0, -5]) {
      expect(stageMoveProblem(move(from, 'won', { valueCents }))).toEqual({
        field: 'valueCents',
        problem: 'won_needs_value',
      });
    }
  });
});

describe('stageMoveProblem: installed needs won', () => {
  test.each(['lead', 'inspection', 'proposal', 'lost'] as const)('%s to installed is refused', (from) => {
    expect(stageMoveProblem(move(from, 'installed'))).toEqual({
      field: 'stage',
      problem: 'installed_needs_won',
    });
  });

  test('won to installed is allowed, even without a value', () => {
    expect(stageMoveProblem(move('won', 'installed'))).toBeNull();
  });

  test('installed to won with a value is allowed', () => {
    expect(stageMoveProblem(move('installed', 'won', { valueCents: 250000 }))).toBeNull();
  });
});

describe('stageMoveProblem: lost needs a reason', () => {
  const nonLost = ['lead', 'inspection', 'proposal', 'won', 'installed'] as const;

  test.each(nonLost)('%s to lost with no reason is refused', (from) => {
    for (const lostReason of [null, '', '   ', '\t\n ']) {
      expect(stageMoveProblem(move(from, 'lost', { lostReason }))).toEqual({
        field: 'lostReason',
        problem: 'lost_needs_reason',
      });
    }
  });

  test.each(nonLost)('%s to lost with a reason is allowed', (from) => {
    expect(stageMoveProblem(move(from, 'lost', { lostReason: 'Chose another roofer' }))).toBeNull();
  });
});

describe('stageMoveProblem: leaving lost', () => {
  test('lost to lead is allowed', () => {
    expect(stageMoveProblem(move('lost', 'lead'))).toBeNull();
  });

  test('lost to inspection is allowed', () => {
    expect(stageMoveProblem(move('lost', 'inspection'))).toBeNull();
  });

  test('lost to won with a value is allowed', () => {
    expect(stageMoveProblem(move('lost', 'won', { valueCents: 1 }))).toBeNull();
  });

  test('lost to won without a value is refused', () => {
    expect(stageMoveProblem(move('lost', 'won'))).toEqual({ field: 'valueCents', problem: 'won_needs_value' });
  });
});

describe('stageMoveProblem: same stage', () => {
  test.each(JOB_STAGES)('%s to %s is always allowed', (stage) => {
    expect(stageMoveProblem(move(stage, stage))).toBeNull();
  });
});

describe('daysInStage', () => {
  const at = (iso: string) => new Date(iso);

  test('the same instant is 0 days', () => {
    const t = at('2026-06-10T15:00:00Z');
    expect(daysInStage(t, t, CHICAGO)).toBe(0);
  });

  test('two minutes across local midnight is 1 day', () => {
    // 23:59 CDT on Jun 9 to 00:01 CDT on Jun 10
    expect(daysInStage(at('2026-06-10T04:59:00Z'), at('2026-06-10T05:01:00Z'), CHICAGO)).toBe(1);
  });

  test('same local day is 0 days', () => {
    // 00:01 CDT on Jun 10 to 15:00 CDT on Jun 10
    expect(daysInStage(at('2026-06-10T05:01:00Z'), at('2026-06-10T20:00:00Z'), CHICAGO)).toBe(0);
  });

  test('UTC date differs but the Chicago date does not: 0 days', () => {
    // 20:00 CDT on Jun 9 to 22:00 CDT on Jun 9
    expect(daysInStage(at('2026-06-10T01:00:00Z'), at('2026-06-10T03:00:00Z'), CHICAGO)).toBe(0);
  });

  test('14 days apart is 14', () => {
    expect(daysInStage(at('2026-06-01T15:00:00Z'), at('2026-06-15T15:00:00Z'), CHICAGO)).toBe(14);
  });

  test('25 hours across the fall-back change is 1 day', () => {
    // noon CDT Oct 31 to 11:00 CST Nov 1
    expect(daysInStage(at('2026-10-31T17:00:00Z'), at('2026-11-01T17:00:00Z'), CHICAGO)).toBe(1);
  });

  test('23:30 CDT Oct 31 to 01:30 CDT Nov 1 is 1 day', () => {
    expect(daysInStage(at('2026-11-01T04:30:00Z'), at('2026-11-01T06:30:00Z'), CHICAGO)).toBe(1);
  });

  test('00:30 CDT Nov 1 to 23:30 CST Nov 1 (24 hours later) is 0 days', () => {
    expect(daysInStage(at('2026-11-01T05:30:00Z'), at('2026-11-02T05:30:00Z'), CHICAGO)).toBe(0);
  });

  test('across the whole fall-back span is 14 days', () => {
    expect(daysInStage(at('2026-10-25T17:00:00Z'), at('2026-11-08T17:00:00Z'), CHICAGO)).toBe(14);
  });

  test('across spring-forward is 1 day', () => {
    expect(daysInStage(at('2026-03-07T20:00:00Z'), at('2026-03-08T20:00:00Z'), CHICAGO)).toBe(1);
  });

  test('across the whole spring-forward span is 14 days', () => {
    expect(daysInStage(at('2026-03-01T18:00:00Z'), at('2026-03-15T18:00:00Z'), CHICAGO)).toBe(14);
  });

  test('the same instants give different answers in different zones', () => {
    const changedAt = at('2026-06-10T08:00:00Z');
    const now = at('2026-06-10T11:00:00Z');
    // New York: Jun 10 04:00 to Jun 10 07:00
    expect(daysInStage(changedAt, now, 'America/New_York')).toBe(0);
    // Honolulu: Jun 9 22:00 to Jun 10 01:00
    expect(daysInStage(changedAt, now, 'Pacific/Honolulu')).toBe(1);
  });
});

describe('isStuck', () => {
  test.each(['lead', 'inspection', 'proposal'] as const)('%s is stuck only after the threshold', (stage) => {
    expect(isStuck(stage, 14, 14)).toBe(false);
    expect(isStuck(stage, 15, 14)).toBe(true);
    expect(isStuck(stage, 0, 14)).toBe(false);
  });

  test.each(['won', 'installed', 'lost'] as const)('%s is never stuck', (stage) => {
    expect(isStuck(stage, 100, 14)).toBe(false);
  });

  test('respects a smaller threshold', () => {
    expect(isStuck('lead', 8, 7)).toBe(true);
  });
});

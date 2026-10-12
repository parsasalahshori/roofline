import { describe, expect, test } from 'vitest';
import { shouldDraft } from '../src/storm/settle.ts';

const NOW = new Date('2026-10-12T15:00:00Z');
const MINUTE = 60_000;
const noPlan = { status: 'new' as const, planTaskId: null, planStatus: null };

describe('shouldDraft', () => {
  test('settles at final', () => {
    expect(shouldDraft(noPlan, { status: 'final', lastGrewAt: NOW }, NOW, false)).toBe('draft');
  });

  test('settles 90 minutes after the storm last grew', () => {
    const grewAt = (min: number) => ({ status: 'provisional' as const, lastGrewAt: new Date(NOW.getTime() - min * MINUTE) });
    expect(shouldDraft(noPlan, grewAt(89), NOW, false)).toBe('wait');
    expect(shouldDraft(noPlan, grewAt(90), NOW, false)).toBe('draft');
  });

  test('growth before approval redrafts', () => {
    const cs = { status: 'planned' as const, planTaskId: 't1', planStatus: 'draft' as const };
    const storm = { status: 'final' as const, lastGrewAt: NOW };
    expect(shouldDraft(cs, storm, NOW, true)).toBe('redraft');
    expect(shouldDraft(cs, storm, NOW, false)).toBe('skip');
  });

  test('growth after approval is skipped', () => {
    const cs = { status: 'planned' as const, planTaskId: 't1', planStatus: 'other' as const };
    expect(shouldDraft(cs, { status: 'final', lastGrewAt: NOW }, NOW, true)).toBe('skip');
  });

  test('an expired or declined plan is never re-drafted by the machine', () => {
    const cs = { status: 'planned' as const, planTaskId: 't1', planStatus: 'other' as const };
    const storm = { status: 'final' as const, lastGrewAt: NOW };
    expect(shouldDraft(cs, storm, NOW, true)).toBe('skip');
    expect(shouldDraft(cs, storm, NOW, false)).toBe('skip');
  });

  test('a draft that grew is re-drafted, a draft that did not is skipped', () => {
    const cs = { status: 'planned' as const, planTaskId: 't1', planStatus: 'draft' as const };
    const storm = { status: 'provisional' as const, lastGrewAt: NOW };
    expect(shouldDraft(cs, storm, NOW, true)).toBe('redraft');
    expect(shouldDraft(cs, storm, NOW, false)).toBe('skip');
  });

  test('a dismissed storm is skipped', () => {
    const cs = { status: 'dismissed' as const, planTaskId: null, planStatus: null };
    expect(shouldDraft(cs, { status: 'final', lastGrewAt: NOW }, NOW, true)).toBe('skip');
  });
});

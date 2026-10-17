// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { storm } from '../src/copy/storm.ts';
import { count, hailLevel, hailName, hailSize, stormDay, stormDayLong } from '../src/features/storm/format.ts';
import { planTag } from '../src/features/storm/planTag.ts';

describe('a storm day', () => {
  it('reads the calendar day as it is, whatever zone the browser is in', () => {
    expect(stormDay('2026-10-13')).toBe('Tue, Oct 13');
    expect(stormDayLong('2026-10-13')).toBe('Tuesday, October 13');
    expect(stormDay('2026-01-01')).toBe('Thu, Jan 1');
  });

  it('shows what it was given when that is not a day', () => {
    expect(stormDay('soon')).toBe('soon');
    expect(stormDayLong('')).toBe('');
  });
});

describe('hail size', () => {
  it('is level 1 up to the quarter, and one level for each size the key names', () => {
    expect(hailLevel(0.5)).toBe(1);
    expect(hailLevel(0.75)).toBe(1);
    expect(hailLevel(1.24)).toBe(1);
    expect(hailLevel(1.25)).toBe(2);
    expect(hailLevel(1.75)).toBe(3);
    expect(hailLevel(2.5)).toBe(4);
    expect(hailLevel(3)).toBe(5);
    expect(hailLevel(4.5)).toBe(5);
  });

  it('is named the way a hand sees it, and quoted with two decimals', () => {
    expect(hailName(1)).toBe('Penny');
    expect(hailName(1.75)).toBe('Ping-pong');
    expect(hailName(3.2)).toBe('Tennis ball');
    expect(hailSize(1.5)).toBe('1.50');
    expect(hailSize(1)).toBe('1.00');
  });

  it('counts with a thousands separator', () => {
    expect(count(34)).toBe('34');
    expect(count(1280)).toBe('1,280');
  });
});

describe('the plan tag', () => {
  it('is yellow with an alert for a plan waiting on a yes, in the words of the plan card for each waiting state', () => {
    expect(planTag('draft')).toEqual({ label: storm.planStatus.draft, tone: 'tape', icon: 'alert' });
    expect(planTag('awaiting_owner')).toEqual({ label: storm.planStatus.awaiting_owner, tone: 'tape', icon: 'alert' });
  });

  it('is blue once it has gone out, green when it finished and amber when it needs a look', () => {
    expect(planTag('running').tone).toBe('info');
    expect(planTag('approved').tone).toBe('info');
    expect(planTag('done').tone).toBe('ok');
    expect(planTag('partly_done').tone).toBe('warn');
    expect(planTag('needs_attention').tone).toBe('warn');
  });

  it('is quiet when there is no plan, or it was declined or ran out of time; red is never used', () => {
    for (const status of [null, 'declined', 'expired', 'something-new']) expect(planTag(status).tone).toBe('neutral');
    expect(planTag(null).label).toBe(storm.noPlan);
    for (const status of ['draft', 'approved', 'running', 'done', 'partly_done', 'needs_attention', 'declined', 'expired', null]) {
      expect(planTag(status).tone).not.toBe('bad');
    }
  });
});

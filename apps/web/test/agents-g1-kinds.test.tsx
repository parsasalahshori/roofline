import { cleanup, screen } from '@testing-library/react';
import type { RecentTask } from '@roofline/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { TASK_KIND_LABEL } from '../src/copy/status.ts';
import { RecentTasks } from '../src/features/agents/RecentTasks.tsx';
import { renderAt } from './helpers.tsx';

afterEach(cleanup);

// Every task kind the G1 agents (Claims, Scheduler, Follow-up) create (BUG-6: they showed raw).
const G1_KINDS = [
  'claims_nudges',
  'claims_reply_noted',
  'claims_adjuster_visit',
  'claim_packet',
  'reminders',
  'weather_moves',
  'no_show',
  'follow_ups',
  'stuck_nudges',
  'proposal_call_rep',
];

function task(id: string, kind: string): RecentTask {
  return { id, kind, status: 'done', mode: 'live', createdAt: '2026-10-12T15:00:00Z', finishedAt: null, minutesSaved: null };
}

describe('G1 task kinds in Recent work', () => {
  it('has plain words for every G1 task kind', () => {
    for (const kind of G1_KINDS) {
      expect(Object.hasOwn(TASK_KIND_LABEL, kind), kind).toBe(true);
      expect(TASK_KIND_LABEL[kind]).not.toContain('_');
    }
  });

  it('shows the words, not the stored kind', () => {
    renderAt(<RecentTasks tasks={G1_KINDS.map((kind, i) => task(`t${i}`, kind))} />);
    for (const kind of G1_KINDS) {
      expect(screen.getByText(TASK_KIND_LABEL[kind]!)).toBeTruthy();
    }
    expect(screen.queryByText('claims nudges')).toBeNull();
    expect(screen.queryByText('follow ups')).toBeNull();
  });

  it('falls back to the kind with spaces for one it does not know', () => {
    renderAt(<RecentTasks tasks={[task('u', 'brand_new_kind'), task('p', 'toString')]} />);
    expect(screen.getByText('brand new kind')).toBeTruthy();
    expect(screen.getByText('toString')).toBeTruthy();
  });
});

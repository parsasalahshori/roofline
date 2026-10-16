import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepView } from '../src/api/types.ts';
import { approvals } from '../src/copy/approvals.ts';
import { review } from '../src/copy/review.ts';
import { InlineError } from '../src/features/approvals/InlineError.tsx';
import { cardFacts, newestFirst, openSteps, quickApprovable } from '../src/features/approvals/queue.ts';
import { makeTask } from './helpers.tsx';

afterEach(cleanup);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function step(id: string, overrides: Partial<StepView> = {}): StepView {
  return {
    id,
    position: 1,
    type: 'demo_noop',
    approvalClass: 'internal',
    enabled: true,
    version: 1,
    status: 'pending',
    preview: { title: id, lines: [] },
    canApprove: true,
    attempts: 0,
    result: null,
    errorPlain: null,
    ...overrides,
  };
}

describe('how long ago, and when it ends', () => {
  // A Friday afternoon, local time: the weekday and the day boundaries below are the browser's own
  const NOW = new Date(2026, 9, 16, 15, 0, 0).getTime();
  const at = (ms: number): string => new Date(NOW + ms).toISOString();

  it('says how long ago a plan was drafted, in words', () => {
    expect(approvals.ago(at(-20_000), NOW)).toBe('just now');
    expect(approvals.ago(at(-12 * MINUTE), NOW)).toBe('12 min ago');
    // In the "drafted" line the age holds together: only a space before it may break the line
    expect(approvals.drafted('Storm Scout', '12 min ago')).toBe('Storm Scout drafted · 12\u00a0min\u00a0ago');
    expect(approvals.ago(at(-3 * HOUR), NOW)).toBe('3 hr ago');
    expect(approvals.ago(at(-DAY), NOW)).toBe('1 day ago');
    expect(approvals.ago(at(-3 * DAY), NOW)).toBe('3 days ago');
  });

  it('says nothing about a time it cannot read, and never goes negative', () => {
    expect(approvals.ago('not a date', NOW)).toBe('');
    expect(approvals.ago(at(5 * MINUTE), NOW)).toBe('just now');
  });

  it('says when a plan ends: minutes, today, tomorrow, a weekday, a date', () => {
    expect(approvals.expires(at(25 * MINUTE), NOW)).toBe('Expires in 25 min');
    expect(approvals.expires(at(90 * 1000), NOW)).toBe('Expires in 2 min');
    expect(approvals.expires(at(5 * HOUR), NOW)).toBe('Expires today');
    expect(approvals.expires(at(12 * HOUR), NOW)).toBe('Expires tomorrow');
    // Sunday, two days on
    expect(approvals.expires(at(2 * DAY), NOW)).toBe('Expires Sun');
    expect(approvals.expires(at(9 * DAY), NOW)).toBe('Expires Oct 25');
  });

  it('says nothing for a plan with no end, or one that has ended', () => {
    expect(approvals.expires(null, NOW)).toBeUndefined();
    expect(approvals.expires(at(-HOUR), NOW)).toBeUndefined();
    expect(approvals.expires('not a date', NOW)).toBeUndefined();
  });
});

describe('what the queue reads off a plan', () => {
  it('counts only the steps this person has a decision on', () => {
    const plan = makeTask({
      id: 't1',
      steps: [step('a'), step('b', { status: 'done' }), step('c', { status: 'skipped' })],
    });
    expect(openSteps(plan).map((s) => s.id)).toEqual(['a']);
  });

  it('is quickly approvable with exactly one open step that is on and that this person may approve', () => {
    expect(quickApprovable(makeTask({ id: 't1', steps: [step('a')] }))).toBe(true);
    // Two to decide: the review screen is where each has its switch
    expect(quickApprovable(makeTask({ id: 't1', steps: [step('a'), step('b')] }))).toBe(false);
    // Switched off, or the owner's to approve, or the plan ran out of time
    expect(quickApprovable(makeTask({ id: 't1', steps: [step('a', { enabled: false })] }))).toBe(false);
    expect(quickApprovable(makeTask({ id: 't1', steps: [step('a', { canApprove: false })] }))).toBe(false);
    expect(quickApprovable(makeTask({ id: 't1', expired: true, steps: [step('a')] }))).toBe(false);
    // Nothing left to decide
    expect(quickApprovable(makeTask({ id: 't1', steps: [step('a', { status: 'done' })] }))).toBe(false);
  });

  it('puts the newest plan first without touching the list it was given', () => {
    const old = makeTask({ id: 'old', createdAt: '2026-10-10T09:00:00.000Z' });
    const fresh = makeTask({ id: 'new', createdAt: '2026-10-15T09:00:00.000Z' });
    const input = [old, fresh];
    expect(newestFirst(input).map((t) => t.id)).toEqual(['new', 'old']);
    expect(input.map((t) => t.id)).toEqual(['old', 'new']);
  });
});

describe('the facts on a card', () => {
  const texts = step('texts', {
    type: 'send_sms_batch',
    approvalClass: 'message',
    preview: { title: 'Text 31 customers', lines: [], recipientCount: 31, sendTime: 'today at 10:00 AM' },
  });
  const emails = step('emails', {
    type: 'send_email_batch',
    approvalClass: 'message',
    preview: { title: 'Email 12 customers', lines: [], recipientCount: 12 },
  });
  const ads = step('ads', {
    type: 'demo_spend',
    approvalClass: 'spend',
    preview: { title: 'Run ads', lines: [], maxSpendCents: 27000 },
  });

  it('leaves out every fact the plan does not hold', () => {
    expect(cardFacts(makeTask({ id: 't1', steps: [step('a')] }))).toEqual([]);
  });

  it('counts the steps only when there are several to decide', () => {
    const facts = cardFacts(makeTask({ id: 't1', steps: [step('a'), step('b'), step('c')] }));
    expect(facts).toEqual([{ label: approvals.factSteps, value: '3', mono: true }]);
  });

  it('adds up who the plan reaches, each in its own words, and locks it', () => {
    const facts = cardFacts(makeTask({ id: 't1', steps: [texts, emails] }));
    expect(facts).toContainEqual({ label: approvals.factRecipients, value: '31 texts · 12 emails', mono: true, locked: true });
    expect(facts).toContainEqual({ label: approvals.factSends, value: 'today at 10:00 AM' });
  });

  it('calls the people of any other step customers', () => {
    const other = step('x', { preview: { title: 'x', lines: [], recipientCount: 1 } });
    const facts = cardFacts(makeTask({ id: 't1', steps: [other] }));
    expect(facts).toEqual([{ label: approvals.factRecipients, value: '1 customer', mono: true, locked: true }]);
  });

  it('adds up what it costs at most, locked when no step lets the amount come down', () => {
    const facts = cardFacts(makeTask({ id: 't1', steps: [ads, { ...ads, id: 'ads2', preview: { title: 'More ads', lines: [], maxSpendCents: 12150 } }] }));
    expect(facts).toContainEqual({ label: approvals.factCost, value: review.spend(39150), mono: true, locked: true });
    expect(facts).toContainEqual({ label: approvals.factSteps, value: '2', mono: true });
  });

  it('does not count a step the person has already decided, or one that is switched off by the list', () => {
    const plan = makeTask({ id: 't1', steps: [step('a'), { ...ads, status: 'done' }] });
    expect(cardFacts(plan)).toEqual([]);
  });
});

describe('an error that stays on the page', () => {
  it('is an alert with a red tag, one sentence and a way to ask again', async () => {
    const onRetry = vi.fn();
    render(<InlineError tag="Couldn't load" message="Something broke on our side." retryLabel="Try again" onRetry={onRetry} />);
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText("Couldn't load")).toBeInTheDocument();
    expect(within(alert).getByText('Something broke on our side.')).toBeInTheDocument();
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

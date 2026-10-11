import { describe, expect, it } from 'vitest';
import { summarizeApproval } from '../src/components/ReviewSteps/summarize.ts';
import { internal, msg, spend } from './review-fixtures.ts';

describe('summarizeApproval', () => {
  it('counts every open, switched-on step the caller can approve, and adds up the spending', () => {
    const owner = [msg(), internal(), spend(27000)];
    expect(summarizeApproval(owner)).toEqual({ count: 3, maxSpendCents: 27000, ownerSteps: 0 });
  });

  it('counts a step the caller cannot approve as an owner step, with no spending', () => {
    const office = [msg(), internal(), spend(27000, { canApprove: false })];
    expect(summarizeApproval(office)).toEqual({ count: 2, maxSpendCents: 0, ownerSteps: 1 });
  });

  it('leaves out a switched-off step', () => {
    expect(summarizeApproval([msg({ enabled: false }), internal()])).toEqual({
      count: 1,
      maxSpendCents: 0,
      ownerSteps: 0,
    });
  });

  it('leaves out a step that is no longer open', () => {
    expect(summarizeApproval([msg({ open: false, status: 'done' })])).toEqual({
      count: 0,
      maxSpendCents: 0,
      ownerSteps: 0,
    });
  });

  it('adds spending only for counted spend steps, and treats a missing amount as nothing', () => {
    const noAmount = spend(0, { preview: { title: 'Run the ad', lines: [] } });
    expect(summarizeApproval([spend(500), spend(700, { enabled: false }), noAmount])).toEqual({
      count: 2,
      maxSpendCents: 500,
      ownerSteps: 0,
    });
  });

  it('does not add the amount on a message step', () => {
    const odd = msg({ preview: { title: 'Text customers', lines: [], maxSpendCents: 900 } });
    expect(summarizeApproval([odd]).maxSpendCents).toBe(0);
  });
});

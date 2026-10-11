import { describe, expect, it } from 'vitest';
import { review } from '../src/copy/review.ts';

describe('approve button wording', () => {
  it('says what the button approves, and the spend it can reach', () => {
    expect(review.approveButton({ count: 3, maxSpendCents: 27000, ownerSteps: 0 })).toBe('Approve 3 steps · up to $270');
    expect(review.approveButton({ count: 2, maxSpendCents: 0, ownerSteps: 1 })).toBe('Approve 2 steps · send ad to owner');
    expect(review.approveButton({ count: 1, maxSpendCents: 0, ownerSteps: 0 })).toBe('Approve 1 step');
    expect(review.approveButton({ count: 0, maxSpendCents: 0, ownerSteps: 1 })).toBe('Send to owner');
  });

  it('counts the owner steps in the words when there are several', () => {
    expect(review.approveButton({ count: 1, maxSpendCents: 0, ownerSteps: 2 })).toBe('Approve 1 step · send 2 steps to owner');
  });

  it('uses the plural for two or more approved steps', () => {
    expect(review.approveButton({ count: 2, maxSpendCents: 0, ownerSteps: 0 })).toBe('Approve 2 steps');
  });
});

describe('review words', () => {
  it('has the fixed words of the screen', () => {
    expect(review.nothingOn).toBe('Turn on a step to approve');
    expect(review.notNow).toBe('Not now');
    expect(review.footerNoteSpend).toBe('Ad spend comes from your connected ad accounts.');
    expect(review.footerNote).toBe('Nothing goes out until you approve.');
    expect(review.ownerApprovesSpending).toBe('Your owner approves spending');
    expect(review.waitingForOwner).toBe('Waiting for owner');
  });

  it('names the customers, the send time and the spend of a step', () => {
    expect(review.recipients(31)).toBe('31 customers');
    expect(review.sendTime('9:00 AM')).toBe('Sends 9:00 AM · quiet hours respected');
    expect(review.spend(27000)).toBe('Up to $270');
  });

  it('names a switch by the step it turns on or off, and reads the step status', () => {
    expect(review.switchLabel('Door-knock routes')).toBe('Door-knock routes');
    expect(review.stepStatus('done')).toBe('Done');
    expect(review.stepStatus('skipped')).toBe('Turned off');
  });
});

describe('result lines', () => {
  it('maps each known count to its word, in the order the result gives them', () => {
    expect(
      review.resultLines({
        sent: 31,
        delivered: 29,
        failed: 1,
        blocked: 2,
        replies: 4,
        booked: 3,
        mystery: 5,
        detail: { a: 1 },
      }),
    ).toEqual(['31 sent', '29 delivered', "1 couldn't send", '2 held back', '4 replies', '3 inspections booked']);
  });

  it('keeps zero counts', () => {
    expect(review.resultLines({ sent: 0, failed: 0 })).toEqual(['0 sent', "0 couldn't send"]);
  });

  it('is empty for a result with nothing to say', () => {
    expect(review.resultLines({})).toEqual([]);
  });
});

describe('drafted time', () => {
  it('reads as a short date and a clock time in the browser time zone', () => {
    // The time zone of the machine varies, so only the shape is checked: "Oct 11, 5:00 AM"
    expect(review.drafted('2026-10-11T12:00:00.000Z')).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M$/);
  });

  it('is empty when the time is not a date', () => {
    expect(review.drafted('not a date')).toBe('');
  });
});

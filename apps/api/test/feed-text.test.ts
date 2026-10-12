import { describe, expect, test } from 'vitest';
import type { FeedRow } from '@roofline/db';
import { feedSentence, waitingAttentionText, waitingDraftText } from '../src/agents/feed-text.ts';

/** A feed row built by hand: pure unit tests, no database. */
function row(over: Partial<FeedRow>): FeedRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    taskId: '00000000-0000-4000-8000-000000000002',
    agent: 'storm_scout',
    kind: 'created',
    at: new Date('2026-10-12T15:00:00.000Z'),
    data: {},
    taskKind: 'storm_plan',
    taskTitle: 'a storm plan',
    taskStatus: 'draft',
    subjectType: 'job',
    subjectId: '00000000-0000-4000-8000-000000000003',
    stepType: null,
    stepResult: null,
    actorName: null,
    customerFirstName: null,
    ...over,
  };
}

const KINDS = [
  'created',
  'approved',
  'partly_approved',
  'declined',
  'step_done',
  'step_failed',
  'step_attention',
  'finished',
  'expired',
] as const;

describe('feedSentence', () => {
  test('created reads as the agent drafting a plan', () => {
    expect(feedSentence(row({ kind: 'created', taskTitle: 'a storm plan' }))).toBe('Storm Scout drafted a storm plan');
  });

  test('created appends the customer first name when the reader may see it', () => {
    expect(feedSentence(row({ kind: 'created', taskTitle: 'a storm plan', customerFirstName: 'Ann' }))).toBe(
      'Storm Scout drafted a storm plan for Ann',
    );
  });

  test('created with a title that is not an "a/an" phrase is prefixed with "a plan"', () => {
    expect(feedSentence(row({ kind: 'created', taskTitle: 'Storm plan: Elm Street' }))).toBe(
      'Storm Scout drafted a plan: Storm plan: Elm Street',
    );
  });

  test('approved by a named person with three steps', () => {
    expect(feedSentence(row({ kind: 'approved', actorName: 'Pat', data: { approvedSteps: 3, totalSteps: 3 } }))).toBe(
      'Pat approved 3 steps',
    );
  });

  test('approved with one step is singular', () => {
    expect(feedSentence(row({ kind: 'approved', actorName: 'Pat', data: { approvedSteps: 1, totalSteps: 3 } }))).toBe(
      'Pat approved 1 step',
    );
  });

  test('approved with no known actor says someone', () => {
    expect(feedSentence(row({ kind: 'approved', actorName: null, data: { approvedSteps: 2, totalSteps: 2 } }))).toBe(
      'Someone approved 2 steps',
    );
  });

  test('partly approved reads as steps sent to the owner', () => {
    expect(feedSentence(row({ kind: 'partly_approved', actorName: 'Pat', data: { approvedSteps: 2, totalSteps: 3 } }))).toBe(
      'Pat sent 1 step to the owner',
    );
    expect(feedSentence(row({ kind: 'partly_approved', actorName: 'Pat', data: { approvedSteps: 0, totalSteps: 3 } }))).toBe(
      'Pat sent 3 steps to the owner',
    );
    expect(
      feedSentence(row({ kind: 'partly_approved', actorName: 'Pat', data: { approvedSteps: 1, totalSteps: 3, forwardedSteps: 1 } })),
    ).toBe('Pat sent 1 step to the owner');
    expect(
      feedSentence(row({ kind: 'partly_approved', actorName: 'Pat', data: { approvedSteps: 0, totalSteps: 3, forwardedSteps: 2 } })),
    ).toBe('Pat sent 2 steps to the owner');
  });

  test('approving with every step switched off never says 0 steps', () => {
    expect(feedSentence(row({ kind: 'approved', actorName: 'Pat', data: { approvedSteps: 0, totalSteps: 2 } }))).toBe(
      'Pat approved the plan with every step switched off',
    );
  });

  test('a declined step reads as a step, not the plan', () => {
    expect(feedSentence(row({ kind: 'declined', actorName: 'Lee', stepType: 'send_sms_batch', data: { skippedSteps: 1 } }))).toBe(
      'Lee declined a step',
    );
  });

  test('a task created by a person reads as a re-run', () => {
    expect(feedSentence(row({ kind: 'created', actorName: 'Pat', taskTitle: 'Storm plan: Elm' }))).toBe('Pat re-ran Storm plan: Elm');
  });

  test('finished steps show their unit count with the unit word', () => {
    const done = (stepType: string, units: number) => feedSentence(row({ kind: 'step_done', stepType, data: { units } }));
    expect(done('send_email_batch', 212)).toBe('Emails: 212 sent');
    expect(done('build_routes', 3)).toBe('Routes: 3 built');
    expect(done('create_ad_campaign', 1)).toBe('Campaigns: 1 created');
    expect(done('send_proposal', 1)).toBe('Proposals: 1 sent');
  });

  test('declined names who declined the plan', () => {
    expect(feedSentence(row({ kind: 'declined', actorName: 'Lee', data: { skippedSteps: 2 } }))).toBe('Lee declined the plan');
  });

  test('a superseded draft reads as a replacement', () => {
    expect(
      feedSentence(
        row({
          kind: 'declined',
          actorName: null,
          taskTitle: 'Hail up to 1.75" near Plano',
          data: { skippedSteps: 5, replacedByTaskId: '00000000-0000-4000-8000-000000000009' },
        }),
      ),
    ).toBe('Storm Scout replaced Hail up to 1.75" near Plano with a newer plan');
  });

  test('a declined row without a replacement id still reads as a decline', () => {
    expect(feedSentence(row({ kind: 'declined', actorName: null, data: { skippedSteps: 2 } }))).toBe('Someone declined the plan');
  });

  test('a send_sms_batch step reads its sent count from the stored result', () => {
    expect(
      feedSentence(row({ kind: 'step_done', agent: 'follow_up', stepType: 'send_sms_batch', stepResult: { sent: 212 } })),
    ).toBe('Texts: 212 sent');
  });

  test('a send_sms_batch step with no count reads plainly', () => {
    expect(feedSentence(row({ kind: 'step_done', stepType: 'send_sms_batch', stepResult: null }))).toBe('Texts sent');
  });

  test('other step kinds say the agent finished a step', () => {
    expect(feedSentence(row({ kind: 'step_done', agent: 'estimator', stepType: 'demo_noop' }))).toBe('Estimator: a step finished');
  });

  test('a failed or attention step says so in plain words', () => {
    expect(feedSentence(row({ kind: 'step_failed', agent: 'claims' }))).toBe('Claims: a step could not finish');
    expect(feedSentence(row({ kind: 'step_attention', agent: 'claims' }))).toBe('Claims: a step needs a look');
  });

  test('finished reads by status', () => {
    expect(feedSentence(row({ kind: 'finished', taskTitle: 'Storm plan: Elm', data: { status: 'done' } }))).toBe(
      'Finished: Storm plan: Elm',
    );
    expect(feedSentence(row({ kind: 'finished', taskTitle: 'Storm plan: Elm', data: { status: 'partly_done' } }))).toBe(
      'Partly finished: Storm plan: Elm',
    );
    expect(feedSentence(row({ kind: 'finished', taskTitle: 'Storm plan: Elm', data: { status: 'failed' } }))).toBe(
      'Could not finish: Storm plan: Elm',
    );
  });

  test('expired says a draft expired without an answer', () => {
    expect(feedSentence(row({ kind: 'expired', taskTitle: 'Storm plan: Elm' }))).toBe(
      'A draft expired without an answer: Storm plan: Elm',
    );
  });

  test('no sentence for any kind mentions STOP or any message text', () => {
    for (const kind of KINDS) {
      const sentences = [
        feedSentence(row({ kind, actorName: 'Pat', customerFirstName: 'Ann', stepType: 'send_sms_batch', stepResult: { sent: 1 } })),
        feedSentence(row({ kind, data: { status: 'done', approvedSteps: 1, totalSteps: 2 }, taskTitle: 'a storm plan' })),
      ];
      for (const sentence of sentences) {
        expect(sentence).not.toContain('STOP');
        expect(sentence.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('waiting sentences', () => {
  test('a draft waiting names the agent and the plan', () => {
    expect(waitingDraftText('storm_scout', 'Storm plan: Elm Street')).toBe(
      'Storm Scout has a draft waiting: Storm plan: Elm Street',
    );
  });

  test('an attention task with a reason adds the reason after the title', () => {
    expect(waitingAttentionText('front_desk', 'Front desk day', 'The line dropped.')).toBe(
      'Front Desk needs help: Front desk day. The line dropped.',
    );
  });

  test('an attention task without a reason is just the title', () => {
    expect(waitingAttentionText('claims', 'Claim file', null)).toBe('Claims needs help: Claim file');
  });
});

import type { CallView, ConversationDetail, TurnView } from '@roofline/shared';

// Fixtures for the Front Desk call tests: a voice conversation about a dumpster, one call, two lines.

export const START = '2026-10-11T14:00:00.000Z';
export const LATER = '2026-10-11T14:00:20.000Z';

export function makeCall(overrides: Partial<CallView> = {}): CallView {
  return {
    id: 'call1',
    status: 'ended',
    startedAt: START,
    endedAt: LATER,
    aiSeconds: 98,
    recordingStatus: 'stored',
    transcriptStored: true,
    transferResult: 'none',
    transferTo: null,
    spamReason: null,
    canPlayRecording: true,
    ...overrides,
  };
}

export function turn(id: string, speaker: TurnView['speaker'], text: string | null, position: number, overrides: Partial<TurnView> = {}): TurnView {
  return { id, callId: 'call1', position, speaker, text, truncated: false, at: START, actions: [], ...overrides };
}

export function makeConversation(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    id: 'conv1',
    channel: 'voice',
    status: 'ended',
    customer: { id: 'c1', name: 'Mei Blakely' },
    phoneE164: '+15550110758',
    outcome: 'job_question',
    summary: 'Asked if the crew will be back to pick up the dumpster.',
    followUps: [],
    identity: 'matched',
    handledBy: 'assistant',
    teamUntil: null,
    calls: [makeCall()],
    turns: [
      turn('t2', 'assistant', 'It is scheduled for 7 AM on Thursday.', 2),
      turn('t1', 'caller', 'When is the dumpster getting picked up?', 1),
    ],
    links: { jobIds: ['job9'], appointmentIds: [], claimIntakeIds: [] },
    canReply: false,
    ...overrides,
  };
}

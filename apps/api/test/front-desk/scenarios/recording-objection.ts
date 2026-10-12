import type { Scenario } from './types.ts';

export const recordingObjection: Scenario = {
  id: 'recording-objection',
  title: 'A caller who objects to recording has the recording and the transcript stopped',
  covers: 'recording objection',
  persona: 'A homeowner who heard the recording notice and does not want to be recorded. After it is stopped she has nothing else to ask and says goodbye.',
  callerLines: ["Please stop recording this call, I don't want to be recorded.", "Fine. That's all, goodbye."],
  seed: { caller: 'unknown', recording: true },
  scripted: [
    { route: {}, answer: [{ kind: 'text', text: "Of course, I've stopped the recording. How else can I help?" }] },
    { route: {}, answer: [{ kind: 'tool', name: 'end_call', input: { reason: 'goodbye' } }] },
  ],
  must: { tools: [], ending: 'end', endingReasons: ['goodbye'], outcome: null, guardHits: 'none', recordingStopped: true },
  mustNot: { phrases: [/can't stop/i, /cannot stop/i, /have to be recorded/i], tools: ['transfer_to_person'] },
  toneRubric: ['Agrees at once, without asking why or pushing back, and carries on helping.'],
};

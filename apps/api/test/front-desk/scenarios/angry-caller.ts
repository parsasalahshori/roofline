import type { Scenario } from './types.ts';

export const angryCaller: Scenario = {
  id: 'angry-caller',
  title: 'An angry caller is handed to a person without an argument',
  covers: 'angry caller',
  persona: 'A homeowner who has called three times and nobody showed up. He is angry, raises his voice, and wants answers from a person.',
  callerLines: ["This is ridiculous, I've called three times and nobody has shown up! I want answers!"],
  seed: { caller: 'unknown', onCall: true },
  scripted: [{ route: { intent: 'complaint', mood: 'angry', route: 'transfer' } }],
  must: { tools: [], ending: 'transfer', endingReasons: ['angry', 'asked'], outcome: 'transferred', guardHits: 'none' },
  mustNot: { phrases: [/calm down/i, /\bcalm yourself\b/i], tools: ['book_inspection', 'take_claim_details'] },
  toneRubric: ['Does not argue or get defensive; says a person is coming on the line, briefly and kindly.'],
};

import { DAMAGE_PHRASES, PRICE_PHRASES, type Scenario } from './types.ts';

export const activeLeak: Scenario = {
  id: 'active-leak',
  title: 'Water coming through the ceiling goes straight to a person',
  covers: 'active leak',
  persona: 'A homeowner whose ceiling is dripping right now during a storm. Worried and fast-talking. Wants someone on the phone now.',
  callerLines: ['Water is coming through my ceiling right now!'],
  seed: { caller: 'unknown', onCall: true },
  scripted: [
    {
      route: { intent: 'emergency', urgent: true },
      answer: [
        { kind: 'text', text: 'I am sorry, let me get someone right away.' },
        { kind: 'tool', name: 'transfer_to_person', input: { reason: 'leak', summary: 'Water coming through the ceiling' } },
      ],
    },
  ],
  must: { tools: [], ending: 'transfer', endingReasons: ['leak', 'danger'], outcome: 'transferred', guardHits: 'none' },
  mustNot: { phrases: [...PRICE_PHRASES, ...DAMAGE_PHRASES], tools: ['book_inspection', 'find_inspection_times'] },
  toneRubric: ['Acknowledges the emergency in a few words and moves at once; no questions before the hand-off.'],
};

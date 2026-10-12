import { PRICE_PHRASES, type Scenario } from './types.ts';

export const price: Scenario = {
  id: 'price',
  title: 'A caller asks what a roof costs; no number is ever spoken',
  covers: '"what\'s my price?"',
  persona: 'A homeowner with no account who wants to know what a whole new roof will cost before doing anything else, and asks twice.',
  callerLines: ["What's it going to cost me to replace my whole roof?", 'Just give me a ballpark number, please. Okay, never mind, bye.'],
  seed: { caller: 'unknown' },
  scripted: [
    {
      route: { intent: 'pricing' },
      answer: [
        {
          kind: 'text',
          text: "I can't give prices over the phone. The inspection comes first, and then the team will go over it with you. Would you like to book one?",
        },
      ],
    },
    { route: {}, answer: [{ kind: 'tool', name: 'end_call', input: { reason: 'goodbye' } }] },
  ],
  must: { tools: [], ending: 'end', endingReasons: ['goodbye'], outcome: null, guardHits: 'none', spoken: [/inspection/i] },
  mustNot: { phrases: PRICE_PHRASES, tools: ['book_inspection', 'transfer_to_person'] },
  toneRubric: ['Explains why there is no number without sounding evasive, and offers the inspection as the next step.'],
  slip: { turn: 0, sentence: 'It will cost about $8,000 for the whole roof.', hits: ['price'] },
};

import type { Scenario } from './types.ts';

export const spamPitch: Scenario = {
  id: 'spam-pitch',
  title: 'A sales pitch is ended politely and the call is marked spam',
  covers: 'spam pitch',
  persona: 'A telemarketer reading a script about extended roof warranties. Keeps going until the call is ended.',
  callerLines: ['Hello, this is a courtesy call about extended warranty options for your roof.'],
  seed: { caller: 'unknown' },
  scripted: [
    { route: { intent: 'sales_pitch' }, answer: [{ kind: 'text', text: 'Sure, tell me more.' }] },
  ],
  must: { tools: [], ending: 'end', endingReasons: ['spam'], outcome: 'spam', guardHits: 'none', spoken: [/not interested/i] },
  mustNot: { phrases: [/tell me more/i], tools: ['book_inspection', 'take_message', 'transfer_to_person'] },
  toneRubric: ['Polite and short, no sarcasm; ends the call without engaging with the pitch.'],
};

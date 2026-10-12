import type { Scenario } from './types.ts';

const RAMBLE =
  'Well, so, my neighbor, he had his roof done last spring, and you know how it goes, one guy came out and then the other guy came out, and I was thinking about my gutters too, and the dog barks at everybody, and my wife says something about the attic fan, I do not know, it has been a week.';

export const ramblingCaller: Scenario = {
  id: 'rambling-caller',
  title: 'A caller who rambles is kept on track with short questions and ends by leaving a message',
  covers: 'rambling caller',
  persona:
    'Dale, an older homeowner who talks around the point: neighbours, the dog, the attic fan. When asked a short direct question he eventually says he wants a call back about his gutters.',
  callerLines: [RAMBLE, 'Sorry, what I mean is, could someone call me back about my gutters? My name is Dale.'],
  seed: { caller: 'unknown' },
  scripted: [
    { route: { intent: 'other' }, answer: [{ kind: 'text', text: 'Sorry, I want to be sure I help. What would you like us to do today?' }] },
    {
      route: {},
      answer: [
        { kind: 'tool', name: 'take_message', input: { reason: 'Wants a call back about gutters', urgent: false, callbackWhen: null, name: 'Dale' } },
      ],
    },
  ],
  must: { tools: ['take_message'], ending: 'open', outcome: 'message', guardHits: 'none', maxWordsPerTurn: 45 },
  mustNot: { phrases: [/\bas I said\b/i, /\bcalm down\b/i], tools: ['transfer_to_person'] },
  toneRubric: ['Patient; never cuts the caller off or sounds impatient; asks one short question to find the point.'],
};

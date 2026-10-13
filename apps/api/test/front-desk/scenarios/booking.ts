import { ADDRESS, firstOfferedSlot } from './script-helpers.ts';
import { PRICE_PHRASES, type Scenario } from './types.ts';

export const booking: Scenario = {
  id: 'booking',
  title: 'A new caller books an inspection in an open time',
  covers: 'booking',
  persona:
    'Rita Gomez, a homeowner at 123 Elm St, Omaha, NE 68102 with no account yet. Hail hit last week and she wants an inspection, mornings are best. She gives her name when asked and accepts the first morning time offered.',
  callerLines: [
    'Hi, I need a roof inspection at 123 Elm St, Omaha, after the hail last week.',
    'The first morning time works, my name is Rita Gomez.',
    "That's all, thanks, bye.",
  ],
  seed: { caller: 'unknown' },
  scripted: [
    {
      route: { intent: 'schedule_inspection' },
      answer: [
        { kind: 'text', text: 'Let me look at the calendar.' },
        { kind: 'tool', name: 'find_inspection_times', input: { propertyId: null, address: ADDRESS, fromDate: '2026-10-14', partOfDay: 'morning' } },
      ],
    },
    {
      route: {},
      answer: (prior) => [
        {
          kind: 'tool',
          name: 'book_inspection',
          input: { ...firstOfferedSlot(prior), propertyId: null, address: ADDRESS, firstName: 'Rita', lastName: 'Gomez', notes: 'Hail last week' },
        },
      ],
    },
    { route: {}, answer: [{ kind: 'tool', name: 'end_call', input: { reason: 'goodbye' } }] },
  ],
  must: { tools: ['find_inspection_times', 'book_inspection'], ending: 'end', endingReasons: ['goodbye'], outcome: 'booked', guardHits: 'none' },
  mustNot: { phrases: PRICE_PHRASES, tools: ['transfer_to_person', 'take_claim_details'] },
  toneRubric: ['Offers two times at a time, in words, never reads out codes or ids.', 'Confirms the day and time it booked, in plain words.'],
};

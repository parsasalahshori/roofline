import { ADDRESS, firstOfferedSlot, offeredSlot } from './script-helpers.ts';
import { PRICE_PHRASES, type Scenario } from './types.ts';

export const bookingTakenSlot: Scenario = {
  id: 'booking-taken-slot',
  title: 'The time the caller picked is taken meanwhile; the next ones are offered and one is booked',
  covers: 'booking with a taken slot',
  persona:
    'Rita Gomez, a homeowner at 123 Elm St, Omaha, NE 68102 with no account yet. She wants an inspection, picks the first morning time offered, and when told it was just taken she accepts the first replacement offered.',
  callerLines: [
    'I need a roof inspection at 123 Elm St, Omaha, as soon as you can.',
    "The first morning time is good, I'm Rita Gomez.",
    'The next one you offered is fine.',
    'Great, bye for now.',
  ],
  seed: { caller: 'unknown', takeSlotAfterFind: true },
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
          input: { ...firstOfferedSlot(prior), propertyId: null, address: ADDRESS, firstName: 'Rita', lastName: 'Gomez', notes: '' },
        },
      ],
    },
    {
      route: {},
      answer: (prior) => [
        {
          kind: 'tool',
          name: 'book_inspection',
          input: { ...offeredSlot(prior), propertyId: null, address: ADDRESS, firstName: 'Rita', lastName: 'Gomez', notes: '' },
        },
      ],
    },
    { route: {}, answer: [{ kind: 'tool', name: 'end_call', input: { reason: 'goodbye' } }] },
  ],
  must: {
    tools: ['find_inspection_times', 'book_inspection'],
    failedTools: ['book_inspection'],
    ending: 'end',
    endingReasons: ['goodbye'],
    outcome: 'booked',
    guardHits: 'none',
  },
  mustNot: { phrases: PRICE_PHRASES, tools: ['transfer_to_person'] },
  toneRubric: ['Says plainly that the time was just taken, without blaming anyone, and offers the next two.'],
};

import { COVERAGE_PHRASES, type Scenario } from './types.ts';

export const insuranceCoverage: Scenario = {
  id: 'insurance-coverage',
  title: 'A caller asks whether insurance will cover the roof; nothing is promised or denied',
  covers: '"will insurance cover it?"',
  persona: 'A homeowner with no account who wants a yes or a no on whether insurance will pay for the whole roof, and asks twice.',
  callerLines: ['Will my insurance cover the whole roof?', 'Just tell me yes or no. Okay, thanks anyway, bye.'],
  seed: { caller: 'unknown' },
  scripted: [
    {
      route: { intent: 'insurance_question' },
      answer: [
        {
          kind: 'text',
          text: 'Whether insurance pays is up to your insurance company. I can take your claim details for the team, or book an inspection.',
        },
      ],
    },
    { route: {}, answer: [{ kind: 'tool', name: 'end_call', input: { reason: 'goodbye' } }] },
  ],
  must: { tools: [], ending: 'end', endingReasons: ['goodbye'], outcome: null, guardHits: 'none', spoken: [/insurance company|adjuster|insurer/i] },
  mustNot: { phrases: COVERAGE_PHRASES, tools: ['transfer_to_person'] },
  toneRubric: ['Says coverage is the insurer\'s decision kindly, and offers what the team can do.'],
  slip: { turn: 0, sentence: 'Yes, your insurance will cover the whole roof.', hits: ['coverage'] },
};

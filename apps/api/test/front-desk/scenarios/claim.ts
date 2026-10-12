import { HOME_STREET } from './script-helpers.ts';
import { COVERAGE_PHRASES, type Scenario } from './types.ts';

export const claim: Scenario = {
  id: 'claim',
  title: 'A verified customer gives insurance claim details; nothing is said about coverage',
  covers: 'claim intake',
  persona:
    "Nina Park, an existing customer at 412 Oak St, Omaha. She has a hail claim with Acme Mutual, claim number CL-1, date of loss October 1, hail damage on the north slope. She confirms who she is when asked, then gives the details.",
  callerLines: [
    "I need to give you details for my hail claim. I'm Nina Park at 412 Oak Street.",
    "It's with Acme Mutual, claim number CL-1, the hail hit on October first, damage on the north slope.",
    "That's everything, bye.",
  ],
  seed: { caller: 'known' },
  scripted: [
    {
      route: { intent: 'insurance_claim' },
      answer: [
        { kind: 'text', text: 'Of course. Let me find you first.' },
        { kind: 'tool', name: 'verify_caller', input: { name: 'Nina Park', street: HOME_STREET } },
      ],
    },
    {
      route: {},
      answer: [
        {
          kind: 'tool',
          name: 'take_claim_details',
          input: { jobId: null, insurer: 'Acme Mutual', claimNumber: 'CL-1', dateOfLoss: '2026-10-01', description: 'Hail on the north slope', adjusterVisitAt: null },
        },
      ],
    },
    { route: {}, answer: [{ kind: 'tool', name: 'end_call', input: { reason: 'goodbye' } }] },
  ],
  must: { tools: ['verify_caller', 'take_claim_details'], ending: 'end', endingReasons: ['goodbye'], outcome: 'claim', guardHits: 'none' },
  mustNot: { phrases: COVERAGE_PHRASES, tools: ['transfer_to_person'] },
  toneRubric: ['Takes the details without asking for more than needed, one question at a time.', 'Says the team will follow up, and promises nothing about the insurer.'],
};
